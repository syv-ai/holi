/**
 * The chat plugin's renderer side (docs/features/chat.md): its conversations
 * as rows of the Agents sidebar's one session list and its main view in the
 * Agents mode, through the slot the agent's Agents view offers, and what its
 * chats add to the mode toggle's report. It knows the agent only as
 * capabilities and the agent's terminal tab by its kind.
 */
import type { PluginStore, RendererPlugin } from '@/plugin-api'
import { CHAT_INFO } from '../info'
import { ChatMain } from './ChatMain'
import {
  archiveChatRowAtom,
  chatEvents,
  chatSessionItemsAtom,
  chatSessionsStatusAtom,
  chatStatusAtom,
  chatsVault,
  newChatViewAtom,
  reloadChatsAtom,
} from './state/chats'

export const chatRenderer: RendererPlugin = {
  info: CHAT_INFO,
  events: chatEvents,
  agentsSlot: {
    sessions: {
      items: chatSessionItemsAtom,
      status: chatSessionsStatusAtom,
      reload: reloadChatsAtom,
      // Chat is the session UI: the list's + opens its composer.
      create: newChatViewAtom,
      archive: archiveChatRowAtom,
    },
    main: ChatMain,
    status: chatStatusAtom,
  },
  vault: (remote: string, store: PluginStore) => chatsVault(remote, store),
}
