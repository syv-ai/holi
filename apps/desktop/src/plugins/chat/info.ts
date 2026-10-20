/** What the chat plugin is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

/**
 * Off by default: the vault's assistant is Claude Code as Claude Code draws it,
 * in a terminal. Chat is another way to talk to the same Claude Code, for a
 * person who would rather not read a TUI.
 */
export const CHAT_INFO: PluginInfo = {
  id: 'chat',
  label: 'Chat',
  default: false,
  requires: ['agent'],
  description:
    'Claude Code in this vault as a conversation in the Agents view: its steps, its permission prompts as cards, and what each turn changed.',
  whenOff:
    'Chat rows leave the Agents view. Their conversations stay on this machine and in Claude Code, and come back when this is on again.',
}
