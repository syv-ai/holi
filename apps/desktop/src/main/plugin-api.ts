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
 * No `electron` value import (types only): plugins load under plain Node in
 * the tests.
 */
import type { Privileges } from 'electron'
import type { PluginInfo } from '@holi/shared'
import type { CapabilityTable } from './capabilities/registry'
import type { SeedContribution } from './vault/seed/types'

/** Undoes what an activation started. Run at quit. */
export type Disposer = () => void | Promise<void>

/** The vault Holi has open. */
export interface LiveVault {
  remote: string
  /** Its clone on this machine. */
  root: string
}

/** What a scheme's handler gets with each request. */
export interface SchemeContext {
  /** The open vault, or null with none open. */
  active(): LiveVault | null
}

/**
 * A URL scheme a plugin serves, such as vault apps' `holi-app:`. Every
 * scheme in the build is registered before the app is ready, whether or not
 * any vault runs its plugin, because Electron allows no later registration:
 * the handler is the fence, and core answers 404 for it while the open vault
 * has its plugin off.
 */
export interface PluginScheme {
  scheme: string
  privileges: Privileges
  /** It serves pages in frames: a frame on it may move within the scheme,
   *  and a link out of it opens in the browser (`window-guard.ts`). */
  frame?: true
  handle(request: Request, ctx: SchemeContext): Response | Promise<Response>
}

/** What a plugin gets when it starts. */
export interface AppContext extends SchemeContext {
  /** Holi's own data directory on this machine, for state a plugin keeps
   *  outside any vault. */
  userData: string
  /**
   * Add capabilities under namespaces this plugin owns. Dispatch refuses them
   * in any vault that has the plugin off. Returns the undo, which the host
   * also runs at quit.
   */
  register(namespaces: readonly string[], table: CapabilityTable): () => void
  /**
   * Tell this plugin's renderer side something about the vault `remote`.
   * `name` is kebab-case and `payload` must survive structured clone. Nothing
   * is sent while that vault has the plugin off.
   */
  emit(remote: string, name: string, payload: unknown): void
  /**
   * Hear `name` from this plugin's renderer side, in the order it was sent.
   * A message about any vault but the open one, or one with the plugin off,
   * is dropped. Returns the undo, which the host also runs at quit.
   */
  on(name: string, handler: (remote: string, payload: unknown) => void): () => void
}

export interface MainPlugin {
  info: PluginInfo
  /** What the plugin writes into a vault that runs it. Its `id` is the
   *  plugin's id. */
  seed?: SeedContribution
  schemes?: readonly PluginScheme[]
  /** Runs once per process, the first time a vault that enables the plugin
   *  is opened. */
  activateApp?(ctx: AppContext): Disposer | Promise<Disposer>
}

export type { PluginInfo } from '@holi/shared'
export type { SeedContribution } from './vault/seed/types'
export type { SettingsFragment } from './agent/seed/claude-settings'
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
export { jsonFileStore, type JsonFileStore } from './json-file-store'
