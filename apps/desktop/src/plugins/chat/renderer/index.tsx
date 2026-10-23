/**
 * The chat plugin's renderer side (docs/features/chat.md): its rows, its
 * main view and the mode's home (the new-session page) in the Agents mode,
 * through the slot the agent's Agents view offers, and what its chats add to
 * the mode toggle's report. It knows the agent only as capabilities.
 */
import type { PluginStore, RendererPlugin } from '@/plugin-api'
import { CHAT_INFO } from '../info'
import { ChatHome, ChatMain } from './ChatMain'
import { ChatSidebar } from './ChatSidebar'
import { chatEvents, chatStatusAtom, chatsVault } from './state/chats'

export const chatRenderer: RendererPlugin = {
  info: CHAT_INFO,
  events: chatEvents,
  agentsSlot: {
    sidebar: ChatSidebar,
    main: ChatMain,
    home: ChatHome,
    status: chatStatusAtom,
  },
  vault: (remote: string, store: PluginStore) => chatsVault(remote, store),
}
