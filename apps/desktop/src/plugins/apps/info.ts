/** What vault apps are, for both of their sides. */
import type { PluginInfo } from '@holi/shared'

/** On by default: an app is something the agent writes on request, and a
 *  vault that never asks for one costs nothing. */
export const APPS_INFO: PluginInfo = {
  id: 'apps',
  label: 'Vault apps',
  default: true,
  description:
    'A folder ending in .app is a small web app the agent writes, opened in its own tab, with records that sync.',
  whenOff: 'An .app folder is an ordinary folder and nothing in it runs. Its records stay.',
}
