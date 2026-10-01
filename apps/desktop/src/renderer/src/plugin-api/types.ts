/**
 * What a plugin's renderer side is: its info, the paths it claims, and the
 * surfaces it adds. Declared here, beside the surface plugins import, so
 * core's state and the plugins read one definition.
 */
import type { Atom } from 'jotai'
import type { ComponentType } from 'react'
import type { PluginInfo } from '@holi/shared'
import type { IconGlyph } from '@/primitives'
import type { PluginDialog } from '@/state/dialogs'

/** One item a claim adds to a file's row menu. */
export interface ClaimMenuItem {
  label: string
  run(ctx: { remote: string; path: string; openDialog: (dialog: PluginDialog) => void }): void
}

/**
 * A plugin owning the vault paths `match` accepts: how one opens in a pane,
 * and what its row menu offers. The first enabled claim with a `view` wins.
 */
export interface PathClaim {
  match(path: string): boolean
  view?: ComponentType<{ path: string }>
  rowMenu?: readonly ClaimMenuItem[]
}

/**
 * A kind of tab that is not a file: the board, mail, settings
 * (docs/features/tabs-panes.md). A tab names it as `{kind: 'surface',
 * surface: kind, id?}`, and the pane, the tab strip, the palette, the "Open"
 * commands, Home and `holi.open` all read it from the registry, so a surface
 * whose plugin is off is simply not there.
 *
 * `kind` is its name: lowercase letters, digits and dashes (`isSurfaceName`).
 * `render` gets the tab's `id` for a surface that is one tab per thing.
 */
export interface Surface {
  kind: string
  label: string
  icon: IconGlyph
  render: ComponentType<{ id?: string }>
  /** Offered as the `home` setting, and opened by it. */
  homeable?: true
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
  visible?: Atom<boolean>
}

export interface RendererPlugin {
  info: PluginInfo
  claims?: readonly PathClaim[]
  surfaces?: readonly Surface[]
  rail?: readonly RailItem[]
}
