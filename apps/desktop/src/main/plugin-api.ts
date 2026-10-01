/**
 * The only main-process module a plugin imports (docs/architecture.md, Plugins).
 *
 * A plugin's main side is a `MainPlugin`: what it is, what it seeds into a
 * vault, and what it starts once per process. Everything else it needs from
 * core is re-exported here, so what plugins depend on is one reviewable list
 * rather than a web of imports into core's internals. `test/plugin-boundary.test.ts`
 * holds core to the other direction: nothing in main imports a plugin except
 * the composition root.
 *
 * No `electron` import: plugins load under plain Node in the tests.
 */
import type { PluginInfo } from '@holi/shared'
import type { CapabilityTable } from './capabilities/registry'
import type { SeedContribution } from './vault/seed/types'

/** Undoes what an activation started. Run at quit. */
export type Disposer = () => void | Promise<void>

/** What a plugin gets when it starts. */
export interface AppContext {
  /** Holi's own data directory on this machine, for state a plugin keeps
   *  outside any vault. */
  userData: string
  /**
   * Add capabilities under namespaces this plugin owns. Dispatch refuses them
   * in any vault that has the plugin off. Returns the undo, which the host
   * also runs at quit.
   */
  register(namespaces: readonly string[], table: CapabilityTable): () => void
}

export interface MainPlugin {
  info: PluginInfo
  /** What the plugin writes into a vault that runs it. Its `id` is the
   *  plugin's id. */
  seed?: SeedContribution
  /** Runs once per process, the first time a vault that enables the plugin
   *  is opened. */
  activateApp?(ctx: AppContext): Disposer | Promise<Disposer>
}

export type { PluginInfo } from '@holi/shared'
export type { SeedContribution } from './vault/seed/types'
export {
  cap,
  type Capability,
  type CapabilityContext,
  type CapabilityTable,
  type CliSpec,
  type Door,
} from './capabilities/registry'
export { CapabilityError } from './capabilities/error'
export { knownPath } from './capabilities/fences'
export {
  flagParam,
  limitParam,
  noParams,
  optionalStringParam,
  paramsObject,
  pathParams,
  stringParam,
} from './capabilities/params'
export { seedFolder } from './vault/seed/folder'
