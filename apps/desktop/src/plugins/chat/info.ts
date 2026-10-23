/** What the chat plugin is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

/**
 * On by default: a conversation is the session UI of the Agents mode
 * (docs/features/chat.md). It is the same Claude Code a terminal would show,
 * on its structured channel, with its own permission prompts as cards.
 */
export const CHAT_INFO: PluginInfo = {
  id: 'chat',
  label: 'Chat',
  default: true,
  requires: ['agent'],
  description:
    'Claude Code in this vault as a conversation in the Agents view: its steps, its permission prompts as cards, and what each turn changed.',
  whenOff:
    'Chat rows leave the Agents view. Their conversations stay on this machine and in Claude Code, and come back when this is on again.',
}
