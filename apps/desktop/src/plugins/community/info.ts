/** What community plugins are, for both of their sides. */
import type { PluginInfo } from '@holi/shared'

/** Off by default: it runs code Holi did not write, so a vault asks for it. */
export const COMMUNITY_INFO: PluginInfo = {
  id: 'community',
  label: 'Community plugins',
  default: false,
  description:
    'Runs plugins from other repositories, such as Prezzi for slide decks: each opens its own files in a tab, served by a program it installs on this machine.',
  whenOff:
    'No community plugin runs, and their files open as plain files. What is installed on this machine and pinned in the vault stays.',
}
