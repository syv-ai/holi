/**
 * What a plugin's renderer side is: its info, and the paths it claims.
 * Declared here, beside the surface plugins import, so core's state and the
 * plugins read one definition.
 */
import type { ComponentType } from 'react'
import type { PluginInfo } from '@holi/shared'
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

export interface RendererPlugin {
  info: PluginInfo
  claims?: readonly PathClaim[]
}
