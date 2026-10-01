/**
 * What a plugin's renderer side is: its info, the paths it claims, and the
 * surfaces it adds. Declared here, beside the surface plugins import, so
 * core's state and the plugins read one definition.
 */
import type { Atom, createStore } from 'jotai'
import type { ComponentType } from 'react'
import type { PluginInfo, VaultSnapshot } from '@holi/shared'
import type { IconGlyph } from '@/primitives'
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
 * `label` may depend on it.
 */
export interface Surface {
  kind: string
  label: string | ((id?: string) => string)
  icon: IconGlyph
  render: ComponentType<{ id?: string }>
  /** Offered as the `home` setting, and opened by it. */
  homeable?: true
  /** The ids there are to open, most recently used first: the palette lists
   *  them, the Home picker offers a folder document's, and its rail item
   *  drills down to them. */
  instances?: Atom<readonly string[]>
  /** Controls at the end of the pane's tab strip while its tab is active. */
  headerActions?: ComponentType<{ id?: string }>
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
  Component: (props: { remote: string }) => React.JSX.Element
}

/** The renderer's one store, as an event handler gets it. */
export type PluginStore = Pick<ReturnType<typeof createStore>, 'get' | 'set'>

/**
 * What a plugin does when its main side emits `name`. Main sends an event
 * only for a vault that runs the plugin, but it may be about a vault other
 * than the open one: `remote` says which, and the handler decides.
 */
export type PluginEventHandler = (
  event: { remote: string; payload: unknown },
  store: PluginStore,
) => void

export interface RendererPlugin {
  info: PluginInfo
  /** Handlers for the plugin's events, by name. Subscribed at boot for every
   *  installed plugin. */
  events?: Readonly<Record<string, PluginEventHandler>>
  claims?: readonly PathClaim[]
  surfaces?: readonly Surface[]
  rail?: readonly RailItem[]
  settingsSections?: readonly SettingsSection[]
}
