/** What automations are, for both of the plugin's sides. */
import type { PluginInfo } from '@holi/shared'

/**
 * On by default, built on the agent: an automation is a prompt this machine
 * runs as an agent session at set times, carried out by Claude Code or by a
 * Holi.
 */
export const AUTOMATIONS_INFO: PluginInfo = {
  id: 'automations',
  label: 'Automations',
  default: true,
  requires: ['agent'],
  // Its skill goes under .claude/, which the agent owns.
  addsTo: ['agent'],
  description:
    'Prompts this machine runs as agent sessions on a schedule, while the vault is open, each one carried out by Claude Code or a Holi.',
  whenOff:
    'Nothing runs on a schedule, and automations leave the Agents view. Their files stay in .holi/schedules/, and what each was approved for here stays too.',
}

/** Until automations are finished, their row in the Agents sidebar is locked
 *  (In progress) and ⌘K leaves them out. Set it to bring both back. */
export const AUTOMATIONS_READY: boolean = false
