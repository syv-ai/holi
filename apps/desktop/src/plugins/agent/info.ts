/** What the agent is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

/** On by default: the vault's assistant is most of what a vault is for. */
export const AGENT_INFO: PluginInfo = {
  id: 'agent',
  label: 'Agent',
  default: true,
  description:
    'Claude Code in this vault, in tabs beside your notes, with the skills and hooks it was given.',
  whenOff:
    'Agent tabs close and the Ask buttons go. Files in .claude/ stay, and Claude Code in a terminal still reads them; no plugin adds new ones there until this is back on.',
  // This machine's: whether this person lets the agent act without asking is
  // theirs to choose, not a teammate's to push to them.
  settings: [
    {
      key: 'bypassPermissions',
      label: 'Start sessions in bypass permissions',
      explanation:
        'New sessions in this vault run every tool without asking first, on this machine. Off, Claude Code asks before it edits a file or runs a command; Shift+Tab in a chat still cycles the mode of one session.',
      type: { kind: 'boolean' },
      default: false,
      target: 'local',
    },
  ],
}
