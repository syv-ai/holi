/**
 * One capability call through one door, the same way for every door: the
 * vault's clone, its snapshot (the open vault's live cache, a fresh scan for
 * any other), the core services, and a rescan of the open vault after a write
 * so the very next read sees it. The doors differ only in how they hand a
 * refusal back: the app bridge and the UI door as a tRPC error, the CLI as a
 * line on stderr.
 *
 * A plugin's capability is refused as "no such method" in a vault that has
 * the plugin off, whatever this process has loaded.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import type { VaultSnapshot } from '@holi/shared'
import { scanVault } from '../vault/vault-store'
import { CapabilityError } from './error'
import type { CapabilityRegistry, CapabilityResult, Door } from './registry'
import type { CoreServices } from './services'

export interface DispatchDeps {
  registry: CapabilityRegistry
  /** The vault's clone on this machine, or null for a vault Holi does not have. */
  rootFor(remote: string): Promise<string | null>
  /** The open vault, or null with none open. */
  active(): {
    remote: string
    snapshot(): VaultSnapshot
    refresh(): Promise<unknown>
  } | null
  core(remote: string, root: string): CoreServices
  /** Whether the vault cloned at `root` runs this plugin. */
  pluginEnabled(plugin: string, root: string): Promise<boolean>
}

export interface CapabilityCall {
  door: Door
  remote: string
  /** The calling app's bundle at the app door; null at every other door. */
  bundle: string | null
  name: string
  params: unknown
}

export type Dispatch = (call: CapabilityCall) => Promise<CapabilityResult>

export function createDispatch(deps: DispatchDeps): Dispatch {
  return async ({ door, remote, bundle, name, params }) => {
    const root = await deps.rootFor(remote)
    if (root === null) throw new CapabilityError('NOT_FOUND', `no such vault: ${remote}`)
    const plugin = deps.registry.pluginOf(name)
    if (plugin !== null && !(await deps.pluginEnabled(plugin, root))) {
      throw new CapabilityError('BAD_REQUEST', `no such method: ${name}`)
    }
    const result = await deps.registry.run(
      name,
      door,
      {
        remote,
        root,
        bundle,
        snapshot: async () => {
          const active = deps.active()
          return active?.remote === remote ? active.snapshot() : scanVault(root)
        },
        core: deps.core(remote, root),
      },
      params,
    )
    if (result.writes) {
      const active = deps.active()
      if (active?.remote === remote) {
        await active.refresh().catch((e) => console.error('[capabilities] post-write rescan:', e))
      }
    }
    return result
  }
}
