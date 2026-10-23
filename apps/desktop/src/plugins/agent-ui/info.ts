/** What the agent's interface is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

/** Where the vault's sessions are listed: `SESSION_LIST` below. */
export type SessionList = 'bubbles' | 'sidebar'

/** On by default, and only ever running beside the agent whose sessions it draws. */
export const AGENT_UI_INFO: PluginInfo = {
  id: 'agent-ui',
  label: 'Agent interface',
  default: true,
  requires: ['agent'],
  description:
    'The agents page, the stack of bubbles over every tab, the smaller chat and the notices.',
  whenOff:
    'The agents page, bubbles, smaller chat, notices and turn review go, and so do the Ask buttons, since an ask lands in a chat. The agent and its sessions keep running, reachable from Claude Code itself.',
  settings: [
    {
      // This machine's: how a person likes their screen laid out is theirs,
      // not a teammate's to push to them.
      key: 'sessionList',
      label: 'Where the sessions are',
      explanation:
        'Bubbles float over the top right of every tab, and a bubble opens a smaller chat. Sidebar lists the live sessions under the file tree instead, and a row opens the full chat.',
      type: {
        kind: 'enum',
        options: [
          { value: 'bubbles', label: 'Bubbles over every tab' },
          { value: 'sidebar', label: 'Rows in the sidebar' },
        ],
      },
      default: 'bubbles',
      target: 'local',
    },
  ],
}
