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
import type { PluginInfo, SnapshotClaim } from '@holi/shared'
import type { AppDoor, AppDoorOpener } from './capabilities/dispatch'
import type { CapabilityTable } from './capabilities/registry'
import type { SeedContribution } from './vault/seed/types'
import type { Route } from './bridge/server'
import type { UiReport } from './capabilities/services'
import type { Transform } from './vault/hooks/runner'
import type { PageWindow, PageWindowOptions } from './page-windows'

export type { PageWindow, PageWindowOptions } from './page-windows'

/** Undoes what an activation started: at leave for a vault's, at quit for
 *  the process's. */
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
  /**
   * Open the app door (docs/features/vault-apps.md): the way a vault app's
   * frame reaches capabilities, with the consent check for entries that ask
   * one (`appGrant`). Once per process, by the apps plugin, its one opener: a
   * second call throws.
   */
  openAppDoor(opener: AppDoorOpener): AppDoor
  /**
   * Ask before Holi quits. `check` runs when someone quits: null lets the
   * quit go on, a question puts it to them, and Cancel keeps Holi open. A
   * disposer cannot ask, because disposers run after the decision to quit.
   * Returns the undo, which the host also runs at quit.
   */
  guardQuit(check: () => QuitQuestion | null): () => void
  /**
   * Serve one exact path on the bridge (`bridge/server.ts`), for a caller
   * that is not a `holi` verb, such as a hook that must answer empty.
   * Returns the undo, which the host also runs at quit.
   */
  route(path: string, route: BridgeRoute): () => void
  /** The directory holding the `holi` command, for a process a plugin starts. */
  binDir(): string
  /**
   * A window of the plugin's own, showing one of its renderer side's pages
   * (`RendererPlugin.pages`), such as the agent's quick panel. Core makes it;
   * the plugin sizes, places, shows and closes it. Every one is closed at quit.
   */
  openPage(options: PageWindowOptions): PageWindow
  /** Bring the main window forward, opening it if it was closed. Resolves
   *  once its page has loaded, so an event sent after it is heard. */
  showMainWindow(): Promise<void>
}

/** What a quit guard asks. */
export interface QuitQuestion {
  message: string
  detail: string
}

/**
 * What a plugin gets in a vault it runs, from when the vault is open until
 * it is left. Everything is bound to that vault.
 */
export interface VaultCtx extends LiveVault {
  /**
   * Hold the vault's sync loop: no autosave commit, pull or push until the
   * returned release runs. Holds from several callers stack; the loop runs
   * again when the last is released, and a release after the vault is left
   * does nothing. Throws if the vault is not open, which is a bug in the
   * caller.
   */
  pauseSync(reason: string): () => void
  /** Commit whatever is dirty now. The new commit's sha, or null for none. */
  commitNow(): Promise<string | null>
  /** The checked-out commit, or null on an unborn branch. */
  head(): Promise<string | null>
  /** Hear what the renderer reports the person is looking at in this vault. */
  onReport(cb: (report: UiReport) => void): () => void
  /** `AppContext.emit` about this vault. */
  emit(name: string, payload: unknown): void
}

export interface MainPlugin {
  info: PluginInfo
  /** What the plugin writes into a vault that runs it. Its `id` is the
   *  plugin's id. */
  seed?: SeedContribution
  schemes?: readonly PluginScheme[]
  /**
   * The markdown files the plugin owns. In a vault that runs it the scanner
   * parses them into `snapshot.claimed[id]` instead of listing them as notes,
   * `normalize-md` puts them in their canonical form. With the plugin off they are plain notes.
   */
  claims?: readonly SnapshotClaim[]
  /**
   * Commit transforms it runs in a vault that runs it, after `relink` and
   * before core's `normalize-md` and `memory-index`. Each is
   * switched by `hooks[name]` in the vault's settings; its label and default
   * are the matching toggle in `info.transforms`, which the settings tab
   * reads too.
   */
  transforms?: readonly Transform[]
  /** Runs once per process, the first time a vault that enables the plugin
   *  is opened. */
  activateApp?(ctx: AppContext): Disposer | Promise<Disposer>
  /**
   * Runs once a vault that enables the plugin is open, after `activateApp`.
   * Opening the vault again while it is open does not run it again. The
   * disposer runs when Holi leaves the vault, while it is still the open one,
   * and at quit before anything else is torn down.
   */
  activateVault?(ctx: VaultCtx): Disposer | Promise<Disposer>
}

export type BridgeRoute = Route
export type { Transform } from './vault/hooks/runner'
export type { StagedChanges } from './vault/hooks/staged'
export type { TransformResult } from './vault/hooks/relink'
export type { UiReport } from './capabilities/services'

export type { ClaimedItem, PluginInfo, SnapshotClaim } from '@holi/shared'
export type { SeedContribution } from './vault/seed/types'
export type { SettingsFragment } from './vault/seed/types'
export {
  cap,
  type Capability,
  type CapabilityContext,
  type CapabilityTable,
  type Admit,
  type CliSpec,
  type Door,
} from './capabilities/registry'
export type { AppDoor, AppDoorOpener } from './capabilities/dispatch'
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
export { resolveBin, toolPath } from './bin'
export { runGit, type RangeFile } from './git'
export { writeAtomic } from './vault/vault-files'
export { holiTheme, readVaultTheme } from './vault/theme'
export { readVaultSettings } from './vault/settings'
export { shellReadBridgeEnv } from './bridge/env-file'
export { mimeFor } from './vault/asset-protocol'
