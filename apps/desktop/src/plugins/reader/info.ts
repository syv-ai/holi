/** What Read all the things is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

export const READER_INFO: PluginInfo = {
  id: 'reader',
  label: 'Read all the things',
  default: true,
  description: 'Extended read-only support for common (and terrible) file formats',
  whenOff: 'Word, PowerPoint and EPUB files show a placeholder. They stay in the vault and sync.',
}
