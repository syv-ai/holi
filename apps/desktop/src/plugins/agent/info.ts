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
}
