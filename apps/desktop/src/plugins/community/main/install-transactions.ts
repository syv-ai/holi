import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isCommunityPluginId } from '@holi/shared'
import { CapabilityError, type CapabilityContext } from '../../../main/plugin-api'
import type {
  AttachmentAdmission,
  CommunityDeps,
  linkRunningCommands,
  listPlugins,
  runChecks,
  seedRunningApps,
} from './capabilities'
import { fetchRelease, readManifest } from './fetch'
import {
  assertInstallAvailable,
  assertInstallProgramDrained,
  reserveInstall,
  retainInstallProgramFailure,
} from './owner'
import { serverKeyMatchesInstall } from './server-authorization'
import { expandCommand, runSetup } from './setup'
import { canonicalJson } from './skill-release'
import type { Install, InstallStore } from './store'

type InstallDeps = Pick<
  CommunityDeps,
  | 'store'
  | 'consent'
  | 'supervisor'
  | 'git'
  | 'firstPartyIds'
  | 'emit'
  | 'scratch'
  | 'checks'
  | 'mutate'
  | 'admit'
  | 'forgetChecks'
  | 'notifyMutation'
  | 'signal'
  | 'live'
  | 'searchPath'
>

type ReleaseRequest = { repo: string; path: string; version: string; expectId?: string }

type RunningPlugins = {
  listPlugins: typeof listPlugins
  linkRunningCommands: typeof linkRunningCommands
  seedRunningApps: typeof seedRunningApps
  runChecks: typeof runChecks
}

export async function installOf(store: InstallStore, id: string): Promise<Install> {
  const install = await store.get(id)
  if (install === null) throw new CapabilityError('NOT_FOUND', `${id} is not installed here`)
  return install
}

export const installCommit = (i: Install) => (i.source.kind === 'release' ? i.source.commit : null)

/** The machine install's reservation spans stop, drain and commit, but the owner queue does not. */
export function installTransactions(
  deps: InstallDeps,
  { admit, ensureContext, signal }: AttachmentAdmission,
  { listPlugins, linkRunningCommands, seedRunningApps, runChecks }: RunningPlugins,
) {
  const claimFirstParty = (id: string) => {
    if (!isCommunityPluginId(id, deps.firstPartyIds()))
      throw new CapabilityError('BAD_REQUEST', `${id} is the name of a plugin built into Holi`)
  }

  type InstallChange = {
    id: string
    validate?(install: Install | null): Promise<void>
  }

  const changeInstall = async <T>(
    ctx: CapabilityContext,
    change: InstallChange,
    work: (transaction: {
      install: Install | null
      revalidate(expected?: Install | null, recordOutcome?: boolean): Promise<void>
    }) => Promise<T>,
    after?: (value: T) => Promise<void>,
  ): Promise<T> => {
    const { id, validate } = change
    let reservation: ReturnType<typeof reserveInstall> | undefined
    try {
      const value = await (async () => {
        try {
          const { install, fingerprint, joined } = await admit(async () => {
            ensureContext(ctx)
            const install = await deps.store.get(id)
            await validate?.(install)
            ensureContext(ctx)
            reservation = reserveInstall(deps.store, id)
            const fingerprint = canonicalJson(install)
            // Stop and revoke all matching rows while still admitted. The
            // reservation outlives the supervisor sweep, through the FS commit.
            const servers = deps.supervisor.stopAll((key) => serverKeyMatchesInstall(key, id))
            const checks = deps.forgetChecks?.(id) ?? deps.checks.forget(ctx.root, id)
            return { install, fingerprint, joined: Promise.allSettled([servers, checks]) }
          })
          // No native receipt, including a sibling vault's check, owns the FIFO.
          for (const result of await joined) if (result.status === 'rejected') throw result.reason
          assertInstallProgramDrained(deps.store, id)
          return await work({
            install,
            async revalidate(expected, recordOutcome = false) {
              const current = await deps.store.get(id)
              if (
                canonicalJson(current) !==
                (expected === undefined ? fingerprint : canonicalJson(expected))
              )
                throw new CapabilityError('CONFLICT', `${id} installation changed during cleanup`)
              await validate?.(current)
              // An already-started setup records its machine-wide outcome even
              // when the initiating vault closes. This cannot authorize a launch.
              if (!recordOutcome) ensureContext(ctx)
              reservation!.assertCurrent()
              assertInstallProgramDrained(deps.store, id)
            },
          })
        } catch (error) {
          retainInstallProgramFailure(deps.store, id, error)
          throw error
        } finally {
          reservation?.release()
        }
      })()
      await after?.(value)
      return value
    } finally {
      // Keep cross-vault link cleanup part of mutation completion, even on a
      // failed drain. Refreshes do not hold the queue while checks run.
      await deps.notifyMutation?.()
    }
  }

  const install = async (
    ctx: CapabilityContext,
    { repo, path, version, expectId }: ReleaseRequest,
  ) => {
    // Fetch into private staging: the plugin id may not be known yet.
    // Do not touch the installed checkout until its reservation commits.
    await mkdir(deps.scratch, { recursive: true })
    const staging = await mkdtemp(join(deps.scratch, 'install-'))
    try {
      const fetched = await fetchRelease(
        {
          repo,
          path,
          version,
          ...(expectId === undefined ? {} : { expectId }),
          scratch: staging,
          releaseDir: () => join(staging, 'release'),
        },
        deps.git,
      )
      const { id } = fetched.manifest
      claimFirstParty(id)
      return await changeInstall(ctx, { id }, ({ revalidate }) =>
        admit(async () => {
          const dest = deps.store.releaseDir(id, fetched.commit)
          const present = await stat(dest).catch(() => null)
          if (present === null) await mkdir(dirname(dest), { recursive: true })
          await revalidate()
          if (present === null) await rename(fetched.dir, dest)
          await deps.store.put({
            id,
            source: { kind: 'release', repo, path, tag: fetched.tag, commit: fetched.commit },
            manifest: fetched.manifest,
            setup: 'none',
          })
          // A new release waits for consent; its commands go until then.
          await linkRunningCommands(ctx.root, deps)
          return (await listPlugins(ctx.root, deps)).find((row) => row.id === id)!
        }),
      )
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  const installFolder = async (ctx: CapabilityContext, folder: string) => {
    const manifest = await readManifest(folder)
    const { id } = manifest
    claimFirstParty(id)
    const validate = async () => {
      if (canonicalJson(await readManifest(folder)) !== canonicalJson(manifest))
        throw new CapabilityError('CONFLICT', `${id} folder manifest changed; look again`)
    }
    return changeInstall(ctx, { id, validate }, ({ revalidate }) =>
      admit(async () => {
        await revalidate()
        await deps.store.put({ id, source: { kind: 'dev', folder }, manifest, setup: 'none' })
        await linkRunningCommands(ctx.root, deps)
        return (await listPlugins(ctx.root, deps)).find((row) => row.id === id)!
      }),
    )
  }

  const consent = async (ctx: CapabilityContext, id: string, commit: string) =>
    deps.mutate(async () => {
      assertInstallAvailable(deps.store, id)
      const install = await installOf(deps.store, id)
      // The commit the dialog showed: a re-fetch in between asks again.
      if (installCommit(install) !== commit)
        throw new CapabilityError('BAD_REQUEST', `${id} changed since it was shown; look again`)
      ensureContext(ctx)
      await deps.consent.grant(id, commit)
    })

  const setup = async (ctx: CapabilityContext, id: string) => {
    const validate = async (install: Install | null) => {
      if (install === null) throw new CapabilityError('NOT_FOUND', `${id} is not installed here`)
      const commit = installCommit(install)
      if (commit !== null && !(await deps.consent.has(id, commit)))
        throw new CapabilityError('FORBIDDEN', `nobody here has agreed to run ${id} ${commit}`)
    }
    return changeInstall(
      ctx,
      { id, validate },
      async ({ install, revalidate }) => {
        const manifest = install!.manifest
        const { setup } = manifest
        if (setup === undefined) {
          return admit(async () => {
            await revalidate()
            await deps.store.setSetup(id, 'ok')
            await seedRunningApps(ctx.root, deps)
            await linkRunningCommands(ctx.root, deps)
            return true
          })
        }
        const { completion } = await admit(async () => {
          await revalidate()
          // Setup can partially change the machine even if it fails or is cancelled.
          await deps.store.setSetup(id, 'failed')
          await revalidate({ ...install!, setup: 'failed' })
          deps.emit(ctx.remote, 'setup-log', { id, line: null })
          const completion = runSetup({
            argv: expandCommand(setup, { vault: ctx.root }),
            signal,
            cwd: deps.store.codeDir(install!),
            logPath: deps.store.setupLog(id),
            onLine: (line) => {
              if (deps.live?.() !== false) deps.emit(ctx.remote, 'setup-log', { id, line })
            },
          }).catch((error: unknown) => {
            retainInstallProgramFailure(deps.store, id, error, deps.signal)
            throw error
          })
          // The native wait is outside admission; the install is still reserved.
          void completion.catch(() => {})
          return { completion }
        })
        const ok = await completion
        if (ok) {
          await admit(async () => {
            await revalidate({ ...install!, setup: 'failed' }, true)
            await deps.store.setSetup(id, 'ok')
            if (deps.live?.() === false || signal?.aborted) return
            await seedRunningApps(ctx.root, deps)
            await linkRunningCommands(ctx.root, deps)
          })
        }
        return ok
      },
      async (ok) => {
        // Our reservation has been released. A newer change may have taken
        // it already; this targeted refresh must not fail on that conflict.
        if (ok && !signal?.aborted)
          await runChecks(
            ctx.root,
            { ...deps, signal },
            { intent: 'refresh', ids: [id], fresh: true },
          )
      },
    )
  }

  const remove = async (ctx: CapabilityContext, id: string) =>
    changeInstall(ctx, { id }, ({ install, revalidate }) =>
      admit(async () => {
        await revalidate()
        await deps.store.remove(id)
        await deps.consent.forget(id)
        await linkRunningCommands(ctx.root, deps)
        if (install?.source.kind === 'release')
          await rm(join(deps.store.releaseDir(id, install.source.commit), '..'), {
            recursive: true,
            force: true,
          })
      }),
    )

  return { install, installFolder, consent, setup, remove }
}
