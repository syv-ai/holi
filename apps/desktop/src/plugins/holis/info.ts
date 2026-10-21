/** What Holis are, for both of the plugin's sides. */
import type { PluginInfo } from '@holi/shared'

/**
 * On by default, built on the agent: a Holi is Claude Code with a soul and a
 * memory, run as the agent runs every session.
 */
export const HOLIS_INFO: PluginInfo = {
  id: 'holis',
  label: 'Holis',
  default: true,
  requires: ['agent'],
  // Its skill goes under .claude/, which the agent owns.
  addsTo: ['agent'],
  description:
    'Agents of this vault with a soul and a memory: send one a document, or give one an automation to carry out.',
  whenOff:
    'Holis leave the Agents view and the Agent menu. Their folders stay in .holi/holis/, and come back when this is on again.',
}
