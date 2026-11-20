import { randomUUID } from 'node:crypto'
import { servedFile } from '@holi/shared'
import { resolveRelative } from '@holi/shared/path-safety-node'
import {
  CapabilityError,
  UnconfirmedOwnedProgramError,
  type CapabilityContext,
} from '../../../main/plugin-api'
import type {
  AttachmentAdmission,
  CommunityDeps,
  ReadPluginEntries,
  listPlugins,
} from './capabilities'
import { assertInstallLaunchable } from './owner'
import { expandCommand, pluginEnv } from './setup'
import { canonicalJson } from './skill-release'
import type { ServerState } from './supervisor'

type ServerDeps = Pick<
  CommunityDeps,
  'store' | 'consent' | 'supervisor' | 'checks' | 'bridgeScript'
>

/** The server key: one per vault, plugin and file. */
const serverKey = (root: string, id: string, path: string) => `${root}\0${id}\0${path}`

export function serverKeyMatchesInstall(key: string, id: string): boolean {
  return key.split('\0')[1] === id
}

/** Authorize each server attempt from the current vault and publish only live leases. */
export function serverAuthorization(
  deps: ServerDeps,
  { admit, ensureContext, signal }: AttachmentAdmission,
  catalog: { pluginEntries: ReadPluginEntries; listPlugins: typeof listPlugins },
) {
  /** Each public lease drops only the supervisor reference its acquire took,
   *  whatever has changed about the plugin since. */
  const leases = new Map<string, () => Promise<void>>()

  const acquire = async (ctx: CapabilityContext, path: string) => {
    const changed = () =>
      new CapabilityError('FORBIDDEN', 'community installation changed while starting')
    const authorize = async () => {
      ensureContext(ctx)
      const entries = await catalog.pluginEntries(ctx.root, deps)
      const entry = entries.find(({ row, enabled }) => enabled && servedFile(row, path) !== null)
      if (entry === undefined) throw new CapabilityError('NOT_FOUND', `no plugin opens ${path}`)
      if (!entry.row.running)
        throw new CapabilityError(
          'FORBIDDEN',
          `${entry.row.name} is not ready on this machine (${entry.row.status})`,
        )
      if (entry.install === null)
        throw new CapabilityError('NOT_FOUND', `${entry.row.id} is not installed here`)
      const { row, install, pin } = entry
      const served = servedFile(row, path)!
      const file = await resolveRelative(ctx.root, served)
      const bridge = deps.bridgeScript()
      const cwd = deps.store.codeDir(install)
      return {
        id: row.id,
        spec: {
          cwd,
          signal,
          fingerprint: canonicalJson({ install, pin, cwd, served, file, bridge }),
          argv: (port: number) =>
            expandCommand(install.manifest.serve!, { file, vault: ctx.root, port }),
          env: (port: number) =>
            pluginEnv({
              HOLI_VAULT_ROOT: ctx.root,
              HOLI_FILE: file,
              HOLI_PORT: String(port),
              ...(bridge === null ? {} : { HOLI_BRIDGE_SCRIPT: bridge }),
            }),
        },
      }
    }
    // Path canonicalization can yield past an attachment's stopAll sweep.
    const assertAdmission = (id: string) => {
      ensureContext(ctx)
      assertInstallLaunchable(deps.store, id)
    }
    const admitted = await admit(async () => {
      const { id, spec } = await authorize()
      assertAdmission(id)
      const key = serverKey(ctx.root, id, path)
      const assertSameGrant = (current: Awaited<ReturnType<typeof authorize>>) => {
        assertAdmission(id)
        if (current.id !== id || current.spec.fingerprint !== spec.fingerprint) throw changed()
      }
      const launchSpec = {
        ...spec,
        authorizeSpawn: <T>(runSpawn: () => T) =>
          admit(async () => {
            assertSameGrant(await authorize())
            // Spawn and publish the native join in the same turn as the final
            // admission checks, with no intervening await.
            return runSpawn()
          }),
      }
      const ready = deps.supervisor.acquire(key, launchSpec, async (resume, retrySignal) => {
        // EMPTY is only a drain receipt, not permission to start again. Box
        // readiness: even a retry must pick its port outside this admission.
        const attempt = await admit(async () => {
          retrySignal.throwIfAborted()
          assertSameGrant(await authorize())
          return resume(launchSpec)
        })
        return attempt.ready
      })
      return { id, assertSameGrant, ready }
    })
    // Keep readiness outside the FIFO so a remove/update can stop this start.
    const acquired = await admitted.ready
    try {
      return await admit(async () => {
        admitted.assertSameGrant(await authorize())
        if (!acquired.isCurrentAndRunning()) throw changed()
        const lease = randomUUID()
        leases.set(lease, acquired.release)
        return { id: admitted.id, port: acquired.port, lease }
      })
    } catch (error) {
      // Join the exact instance outside admission. An unknown drain keeps
      // the supervisor row fenced and carries the denial as the first error.
      try {
        await acquired.release()
      } catch (cleanupError) {
        if (
          cleanupError instanceof UnconfirmedOwnedProgramError &&
          error instanceof Error &&
          !(error instanceof UnconfirmedOwnedProgramError)
        )
          throw new UnconfirmedOwnedProgramError(cleanupError.cause, cleanupError.lease, error)
        if (cleanupError !== error) console.error('[community] server release:', cleanupError)
      }
      throw error
    }
  }

  const release = async (lease: string) => {
    const release = leases.get(lease)
    if (release === undefined) return
    await release()
    leases.delete(lease)
  }

  const state = async (ctx: CapabilityContext, path: string): Promise<ServerState | null> => {
    const rows = await catalog.listPlugins(ctx.root, deps)
    for (const row of rows.filter((r) => servedFile(r, path) !== null)) {
      const state = deps.supervisor.state(serverKey(ctx.root, row.id, path))
      if (state !== null) return state
    }
    return null
  }

  return { acquire, release, state }
}
