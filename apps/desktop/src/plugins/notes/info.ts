/** What Notes is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

/** Off by default: it adds an app folder to the vault, which a vault that
 *  keeps its notes as markdown does not need. */
export const NOTES_INFO: PluginInfo = {
  id: 'notes',
  label: 'Notes',
  default: false,
  description:
    'A notebook app in the style of Apple Notes: a list grouped by day, search, and a plain editor. Adds a Notes.app folder to the vault.',
  whenOff:
    'The Notes.app folder stays in the vault as an ordinary app and keeps working while Vault apps is on. Its notes stay.',
}
