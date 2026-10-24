/**
 * The chat plugin's renderer side (docs/features/chat.md): its conversations
 * as rows of the Agents sidebar's one session list, its main view and the
 * mode's home (the new-session page) in the Agents mode, through the slot
 * the agent's Agents view offers, and what its chats add to the mode
 * toggle's report, and a background run's conversation for the agent's
 * session view. It knows the agent only as capabilities.
 */
import type { PluginStore, RendererPlugin } from '@/plugin-api'
import { CHAT_INFO } from '../info'
import { ChatHome, ChatMain } from './ChatMain'
import { ConversationView } from './ConversationView'
import {
  archiveChatRowAtom,
  chatEvents,
  deleteChatRowAtom,
  pinChatRowAtom,
  renameChatRowAtom,
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
      rename: renameChatRowAtom,
      pin: pinChatRowAtom,
      remove: deleteChatRowAtom,
    },
    main: ChatMain,
    home: ChatHome,
    conversation: ConversationView,
    status: chatStatusAtom,
  },
  vault: (remote: string, store: PluginStore) => chatsVault(remote, store),
}
