/** What Workspace is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

/** Off by default: it changes where the frame's parts sit and what the apps and
 *  agenda items open, which a vault opts into. */
export const WORKSPACE_INFO: PluginInfo = {
  id: 'workspace-ui',
  label: 'Workspace',
  default: false,
  description:
    'A second look for the frame: the nav menu as a dock at the foot of the window holding the open tabs, an Apps page, and the Agenda opened on the month.',
  whenOff:
    'The nav menu returns to the sidebar, each pane gets its tab strip back, Apps lists its open apps in the menu, and the Agenda opens as a list.',
}
