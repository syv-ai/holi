/** What Workspace is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

/** Off by default: it changes where the frame's parts sit and what the apps item
 *  opens, which a vault opts into. */
export const WORKSPACE_INFO: PluginInfo = {
  id: 'workspace-ui',
  label: 'Workspace',
  default: false,
  description:
    'A second look for the frame: the nav menu as a dock at the foot of the window holding the open tabs, Settings and sync at the top of the sidebar, and an Apps page.',
  whenOff:
    'The nav menu returns to the sidebar with Settings and sync in it, each pane gets its tab strip back, and Apps lists its open apps in the menu.',
}
