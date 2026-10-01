/** What vault apps are, for both of their sides. */
import type { PluginInfo } from '@holi/shared'

/** On by default: an app is something the agent writes on request, and a
 *  vault that never asks for one costs nothing. */
export const APPS_INFO: PluginInfo = { id: 'apps', label: 'Vault apps', default: true }
