/** What the agent's interface is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

/** On by default, and only ever running beside the agent whose sessions it draws. */
export const AGENT_UI_INFO: PluginInfo = {
  id: 'agent-ui',
  label: 'Agent interface',
  default: true,
  requires: ['agent'],
  description:
    'The agents page, the stack of bubbles over every tab, the smaller chat and the notices.',
  whenOff:
    'The agents page, bubbles, smaller chat and notices go. The agent and its sessions keep running, reachable from Claude Code itself.',
}
