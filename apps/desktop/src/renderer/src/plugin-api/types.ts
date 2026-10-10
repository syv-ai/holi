/**
 * What a plugin's renderer side is: its info, the paths it claims, and the
 * surfaces it adds. Declared here, beside the surface plugins import, so
 * core's state and the plugins read one definition.
 */
import type { Atom, createStore, WritableAtom } from 'jotai'
import type { ComponentType } from 'react'
import type { PluginInfo, VaultSnapshot } from '@holi/shared'
import type { IconGlyph } from '@/primitives'
import type { Command } from '@/state/commands'
import type { PluginDialog } from '@/state/dialogs'

/** One item a claim adds to a file's row menu. */
export interface ClaimMenuItem {
  label: string
  /** Shown only when this says so, from the path and the vault as scanned.
   *  Pure: the menu asks it on every open. */
  when?(path: string, snapshot: VaultSnapshot): boolean
  run(ctx: { remote: string; path: string; openDialog: (dialog: PluginDialog) => void }): void
}

/**
 * A directory that is one document, such as a vault app's `Budget.app`: the
 * tree lists it among the files and opens it, rather than listing what is
 * inside, and it opens as the tab `{surface, id: path}`.
 */
export interface FolderClaim {
  /** The surface it opens in, with its path as the tab's id. */
  surface: string
  /** The file that makes a matched directory a document. Without it the
   *  directory is an ordinary folder; moving it moves the tab. */
  entry: string
  /** False while the document is a draft: still listed as one, but a click
   *  shows its files, since there is nothing to open yet. `has` says whether
   *  a vault path exists. */
  ready?(path: string, has: (path: string) => boolean): boolean
}

/** How a claimed path is shown in the file tree. */
export interface ClaimDecoration {
  icon: IconGlyph
  /** What its row is called. */
  name(path: string): string
  /** What a rename keeps on the end of the name typed, such as `.app`. */
  suffix(path: string): string
}

/** Something the explorer's New menu makes. */
export interface ClaimCreate {
  id: string
  label: string
  icon: IconGlyph
  /** What its name field says while empty. */
  placeholder: string
  /** Make it, named `name`, in the folder `parent` ('' for the root). Resolves
   *  to a vault path to open, or null. */
  run(ctx: { remote: string; parent: string; name: string }): Promise<string | null>
}

/**
 * A plugin owning the vault paths `match` accepts: how one opens in a pane,
 * and what its row menu offers. The first enabled claim with a `view` wins.
 * `match` runs for every folder in the tree, so keep it a cheap test of the
 * path's spelling.
 */
export interface PathClaim {
  match(path: string): boolean
  view?: ComponentType<{ path: string }>
  folder?: FolderClaim
  decorate?: ClaimDecoration
  rowMenu?: readonly ClaimMenuItem[]
  create?: ClaimCreate
  /**
   * The file's canonical form: the same function as the main side's claim,
   * which the `normalize-md` commit transform applies. The editor treats a
   * file rewritten into it as Holi's own tidy, not a foreign edit.
   */
  normalize?(text: string): string
}

/**
 * A kind of tab that is not a file: the board, mail, settings
 * (docs/features/tabs-panes.md). A tab names it as `{kind: 'surface',
 * surface: kind, id?}`, and the pane, the tab strip, the palette, the "Open"
 * commands, Home and `holi.open` all read it from the registry, so a surface
 * whose plugin is off is simply not there.
 *
 * `kind` is its name: lowercase letters, digits and dashes (`isSurfaceName`).
 * `render` gets the tab's `id` for a surface that is one tab per thing, and
 * `label` may depend on it. `visible` is false only for a `keepMounted` tab
 * that is not its pane's active one.
 */
export interface Surface {
  kind: string
  label: string | ((id?: string) => string)
  icon: IconGlyph
  render: ComponentType<{ id?: string; visible: boolean }>
  /** Every tab of it stays mounted in its pane, hidden while another tab is
   *  active, so it keeps state a remount would lose (a terminal's
   *  scrollback). */
  keepMounted?: true
  /** Its tabs open only from its plugin's own controls: the palette, the
   *  Open commands and Home do not offer it. */
  unlisted?: true
  /** Offered as the `home` setting, and opened by it. */
  homeable?: true
  /** The ids there are to open, most recently used first: the palette lists
   *  them, the Home picker offers a folder document's, and its rail item
   *  drills down to them. */
  instances?: Atom<readonly string[]>
  /** Controls at the end of the pane's tab strip while its tab is active. */
  headerActions?: ComponentType<{ id?: string }>
  /**
   * The tabs of it that exist now, and how each looks, for a surface whose
   * ids come and go outside the vault (an agent's terminals). The tab strip
   * names and marks a tab from it, the palette lists every one, and a recent
   * of one lives only while it is listed. Its tabs take the keyboard
   * themselves when they open.
   */
  tabs?: Atom<readonly SurfaceTabLook[]>
  /** While one of its tabs is active, the note focused before it stays the
   *  focused one, as main is told: typing to the agent happens in its tab. */
  keepsFocusedNote?: true
}

/** How one tab of a surface looks right now (`Surface.tabs`). */
export interface SurfaceTabLook {
  id: string
  label: string
  /** The tab's tooltip, when it says more than the label. */
  tooltip?: string
  /** A background class for a dot drawn in place of the surface's icon. */
  dot?: string
}

/** Something the palette lists that is not a tab yet, such as a live agent
 *  session (`RendererPlugin.palette`). */
export interface PaletteItem {
  key: string
  name: string
  /** A background class for the dot it is shown with. */
  dot: string
}

/**
 * A surface's place in the nav menu. `order` sorts the menu, core's own
 * items included (Home 0, Search 10, Apps 20, Board 30, Agents 60, Sync 70,
 * Settings 100). `visible` is an atom so a plugin can show or hide its item
 * without the menu calling a hook per item.
 */
export interface RailItem {
  surface: string
  order: number
  /** The menu's word for it when that is not the surface's own label: a
   *  surface with instances is listed as a group of them, such as "Apps". */
  label?: string
  visible?: Atom<boolean>
  /** Run this command (`state/commands.ts`) instead of opening the surface. */
  command?: string
  /** While true, the item shows that something of the surface's is running. */
  live?: Atom<boolean>
}

export interface SettingsSectionHeading {
  /** The anchor the rail scrolls to: `headingId(title)`, never hand-written. */
  id: string
  title: string
}

/**
 * A section of the settings tab (docs/features/settings.md). Core's own and
 * every enabled plugin's are listed in one rail; a plugin's come after core's
 * vault sections and before Vault and Account.
 */
export interface SettingsSection {
  id: string
  label: string
  /** What the rail shows beneath the section you are in: declared, so a test
   *  can hold the section to rendering each one. */
  headings: readonly SettingsSectionHeading[]
  /** The files this section is a view of, offered at the bottom of it. */
  files: readonly string[]
  /** Shown inside core's Plugins page, under its label, rather than as a
   *  section of its own: a plugin's settings about plugins. */
  within?: 'plugins'
  Component: (props: { remote: string }) => React.JSX.Element
}

/** The renderer's one store, as an event handler gets it. */
export type PluginStore = Pick<ReturnType<typeof createStore>, 'get' | 'set' | 'sub'>

/**
 * What a plugin does when its main side emits `name`. Main sends an event
 * only for a vault that runs the plugin, but it may be about a vault other
 * than the open one: `remote` says which, and the handler decides.
 */
export type PluginEventHandler = (
  event: { remote: string; payload: unknown },
  store: PluginStore,
) => void

/** What an ask or a start answers: done, or why not, in words to show. */
export type AskResult = { ok: true } | { ok: false; message: string }

/** One of the vault's live agent sessions, as an ask offers it. */
export interface AgentSessionRow {
  id: string
  name: string
  state: 'needs-you' | 'working' | 'idle'
}

/** Where an ask may go, and where it goes when nobody picks. */
export interface AskTargets {
  /** Sessions that can take an ask now. */
  sessions: readonly { id: string; name: string }[]
  /** A session id, or `'new'` for a new session. */
  default: string
}

/**
 * The vault's agent, as everything outside its plugin uses it: every "Ask"
 * button, the reconcile hand-off and the stuck-push investigation. Core's
 * `useAgentService()` is null while no plugin provides one.
 */
export interface AgentService {
  /** What it is called in copy, such as "Ask Claude to reconcile". */
  name: string
  sessions: Atom<readonly AgentSessionRow[]>
  targets: Atom<AskTargets>
  /** Put `text` in a session's input, unsent, and bring it forward. */
  ask(args: { text: string; target: string }): Promise<AskResult>
  /** A new session whose first turn is `prompt`, brought forward. */
  start(args: { name?: string; prompt: string }): Promise<AskResult>
}

/** What a plugin provides for `AgentService`: the same, as atoms, which
 *  core binds to the store. */
export interface AgentServiceSource {
  name: string
  sessions: Atom<readonly AgentSessionRow[]>
  targets: Atom<AskTargets>
  ask: WritableAtom<null, [{ text: string; target: string }], Promise<AskResult>>
  start: WritableAtom<null, [{ name?: string; prompt: string }], Promise<AskResult>>
}

export interface RendererPlugin {
  info: PluginInfo
  /** Handlers for the plugin's events, by name. Subscribed at boot for every
   *  installed plugin. */
  events?: Readonly<Record<string, PluginEventHandler>>
  /** Its path claims, or an atom of them for a plugin whose claims follow
   *  what main tells it (the community plugins' files). */
  claims?: readonly PathClaim[] | Atom<readonly PathClaim[]>
  surfaces?: readonly Surface[]
  rail?: readonly RailItem[]
  settingsSections?: readonly SettingsSection[]
  /** Shown in the hidden sidebar's rail, above the nav menu. */
  railSection?: ComponentType
  /** Shown in the sidebar, under the file tree. */
  sidebarSection?: ComponentType
  /** Right-hand drawers; each decides whether it is open. */
  drawers?: readonly ComponentType[]
  /**
   * Why leaving the open vault (switching, or adding one) costs something
   * now, as a sentence, or null when it costs nothing. Core asks before
   * leaving while any plugin's says something.
   */
  leaveGuard?: Atom<string | null>
  /** Runs while `remote` is the open vault and the plugin runs in it; the
   *  returned undo runs when either stops. */
  vault?(remote: string, store: PluginStore): () => void
  agent?: AgentServiceSource
  /** Commands, run by id like core's (`state/commands.ts`), while it runs. */
  commands?: readonly Command[]
  /**
   * What the palette lists beside the vault's files that is not a tab, and
   * how one is opened: `open` gets its key, and focuses what it opens.
   */
  palette?: {
    items: Atom<readonly PaletteItem[]>
    open: WritableAtom<null, [key: string], unknown>
  }
}
