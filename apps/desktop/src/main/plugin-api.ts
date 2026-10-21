/**
 * The only main-process module a plugin imports (docs/architecture.md, Plugins).
 *
 * A plugin's main side is a `MainPlugin`: what it is, what it seeds into a
 * vault, and what it starts in a vault that runs it. Everything else it needs from
 * core is re-exported here, so what plugins depend on is one reviewable list
 * rather than a web of imports into core's internals. `test/plugin-boundary.test.ts`
 * holds core to the other direction: nothing in main imports a plugin except
 * the composition root.
 *
 * No `electron` value import (types only): plugins load under plain Node in
 * the tests.
 */
import type { Privileges } from 'electron'
import type {
  CommentMention,
  PluginInfo,
  SnapshotClaim,
  VaultEvent,
  VaultSnapshot,
} from '@holi/shared'
import type { AppDoor, AppDoorOpener } from './capabilities/dispatch'
import type { CapabilityTable } from './capabilities/registry'
import type { SeedContribution } from './vault/seed/types'
import type { Route } from './bridge/server'
import type { UiReport } from './capabilities/services'
import type { Transform } from './vault/hooks/runner'

/** Undoes what an activation started, when the plugin stops: turned off,
 *  the vault left, or Holi quitting. */
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

/**
 * What a plugin gets when it starts in a vault, bound to that vault until it
 * stops: turned off, the vault left, or Holi quitting. Nothing a plugin starts
 * outlives its vault, so nothing carries from one vault to the next. Every
 * undo below the host also runs when it stops.
 */
export interface PluginCtx extends LiveVault, SchemeContext {
  /** Holi's own data directory on this machine, for state a plugin keeps
   *  outside any vault. */
  userData: string
  /**
   * Add capabilities under namespaces this plugin owns. Dispatch refuses them
   * in any vault that has the plugin off. Returns the undo.
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
   * is dropped. Returns the undo.
   */
  on(name: string, handler: (remote: string, payload: unknown) => void): () => void
  /**
   * Open the app door (docs/features/vault-apps.md): the way a vault app's
   * frame reaches capabilities, with the consent check for entries that ask
   * one (`appGrant`). The apps plugin is its one opener: a second call while
   * it is open throws. Closed when the plugin stops.
   */
  openAppDoor(opener: AppDoorOpener): AppDoor
  /**
   * Ask before Holi quits. `check` runs when someone quits: null lets the
   * quit go on, a question puts it to them, and Cancel keeps Holi open. A
   * disposer cannot ask, because disposers run after the decision to quit.
   * Returns the undo.
   */
  guardQuit(check: () => QuitQuestion | null): () => void
  /**
   * Serve one exact path on the bridge (`bridge/server.ts`), for a caller
   * that is not a `holi` verb, such as a hook that must answer empty.
   * Returns the undo.
   */
  route(path: string, route: BridgeRoute): () => void
  /** The directory holding the `holi` command, for a process a plugin starts. */
  binDir(): string
  /** The signed-in GitHub token, or null: for a plugin that fetches from a
   *  repository the person can read, as vault clones do. */
  githubToken(): string | null
  /**
   * Let a frame showing `origin` (`http://127.0.0.1:3040`) move within it,
   * and send a link out of it to the browser, as a `frame` scheme's frames
   * are (`window-guard.ts`). Returns the undo.
   */
  frameOrigin(origin: string): () => void
  /**
   * Hold the vault's sync loop: no autosave commit, pull or push until the
   * returned release runs. Holds from several callers stack; the loop runs
   * again when the last is released, and a release after the vault is left
   * does nothing.
   */
  pauseSync(reason: string): () => void
  /** Commit whatever is dirty now. The new commit's sha, or null for none. */
  commitNow(): Promise<string | null>
  /** The checked-out commit, or null on an unborn branch. */
  head(): Promise<string | null>
  /** Hear what the renderer reports the person is looking at in this vault. */
  onReport(cb: (report: UiReport) => void): () => void
  /**
   * Hear about a comment a pull brought into this vault that mentions the
   * person signed in, written by someone else (docs/features/note-comments.md).
   * Only on a pull: there is no server to say so sooner. Returns the undo.
   */
  onMention(cb: (mention: NoteMention) => void): () => void
  /**
   * A native notification, the one the reminders use. Raised only while no
   * Holi window has focus: Holi's banners never cover Holi. True when it was
   * raised. Clicking it brings Holi's window forward, opening one if none is
   * open, then runs `onClick`.
   */
  notify(notice: Notice): boolean
  /** Whether a Holi window has focus now. */
  focused(): boolean
  /** Hear each scan of this vault, the latest one first, at once. Returns
   *  the undo. */
  onSnapshot(cb: (snapshot: VaultSnapshot) => void): () => void
  /**
   * What the plugins started in this vault tell each other: the events that
   * start scheduled agents (`VaultEvent`, `packages/shared/src/triggers.ts`).
   * `emit` reaches every listener in the vault, the emitter's own included,
   * after the emitter's step; `on` returns the undo. Nothing is kept: a
   * plugin that starts later hears only what is said after, which is why the
   * sources and the agent say theirs again on every check.
   */
  events: {
    emit(event: VaultEvent): void
    on(cb: (event: VaultEvent) => void): () => void
  }
}

/** A comment on the note `notePath` that mentions the person (`PluginCtx.onMention`). */
export interface NoteMention extends CommentMention {
  notePath: string
}

/** A native notification (`PluginCtx.notify`). */
export interface Notice {
  title: string
  body: string
  onClick?: () => void
}

/**
 * What a plugin's work across vaults gets (`MainPlugin.background`), for as
 * long as it runs: not bound to any one vault, and not to the open one.
 */
export interface AppCtx {
  /** Holi's own data directory on this machine. */
  userData: string
  /** The registered vaults on this machine that run the plugin, read fresh. */
  vaults(): Promise<LiveVault[]>
  /** The vault at `root` as scanned, with the claims of what it runs. */
  scan(root: string): Promise<VaultSnapshot>
  /** Show `path` of the vault `remote` in a tab: the window brought forward,
   *  or made when there is none, and the vault switched to when it is not
   *  the open one. */
  open(remote: string, path: string): void
  /** The GitHub login this machine is signed in as, or null. */
  viewerLogin(): string | null
  /** A native notification, `PluginCtx.notify`'s kind, but raised whether or
   *  not a Holi window has focus: work across vaults says what is due now,
   *  whatever the person is looking at. */
  notify(notice: Notice): void
}

/** What a quit guard asks. */
export interface QuitQuestion {
  message: string
  detail: string
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
  /**
   * Starts the plugin in a vault that runs it, once the vault is open: at the
   * open, or when the vault turns it on. The disposer runs when it stops,
   * while the vault is still the open one: turned off (by Holi's settings or a
   * hand edit), the vault left, or Holi quitting. A plugin it requires starts
   * before it and stops after it.
   */
  activate?(ctx: PluginCtx): Disposer | Promise<Disposer>
  /**
   * Work it does across every registered vault that runs it, whether or not
   * that vault is open, for as long as Holi runs: reminders. It starts at
   * launch while some registered vault runs the plugin, and stops when none
   * does any more (looked at again on each settings write). While any
   * plugin's runs, Holi stays in the menu bar with its window closed, and the
   * tray says `why` it does.
   */
  background?: {
    why: string
    start(ctx: AppCtx): Disposer | Promise<Disposer>
  }
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
export {
  knownPath,
  readableOrNull,
  requireOpen,
  shownPath,
  VAULT_NOT_OPEN,
  vaultNotOpen,
  writableFile,
  writablePath,
} from './capabilities/fences'
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
export { defaultProbePid, type PidState } from './process-group'
export { remoteUrl, runGit, type RangeFile } from './git'
export { gitignoreWith } from './vault/seed/core'
export {
  absPathFor,
  listFiles,
  removeDocFile,
  withFileLock,
  writeAtomic,
} from './vault/vault-files'
export { moveNotes } from './vault/move'
export { renameNote } from './vault/rename'
export { holiTheme, readVaultTheme } from './vault/theme'
export { readVaultSettings, writePluginSettings } from './vault/settings'
export { installedInfos } from './plugin-host/installed'
export { shellReadBridgeEnv } from './bridge/env-file'
export { mimeFor } from './vault/asset-protocol'
