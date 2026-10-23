/** What the chat part is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

/**
 * Built in: a conversation is the session UI of the Agents mode
 * (docs/features/chat.md), so no vault can turn it off. It is the same Claude
 * Code a terminal would show, on its structured channel, with its own
 * permission prompts as cards. Written to the plugin contract all the same:
 * it reaches core only through the plugin API.
 */
export const CHAT_INFO: PluginInfo = {
  id: 'chat',
  label: 'Chat',
  default: true,
  builtIn: true,
  requires: ['agent'],
  description:
    'Claude Code in this vault as a conversation in the Agents view: its steps, its permission prompts as cards, and what each turn changed.',
}
