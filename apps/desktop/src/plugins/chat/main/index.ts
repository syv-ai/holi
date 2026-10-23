/**
 * The chat plugin's main side (docs/features/chat.md): Claude Code on its
 * structured channel, one process per live conversation, in the open vault.
 *
 * It stands on the agent plugin and reaches it only through the agent's
 * capabilities: where and how Claude Code runs (`agent.target`), the vault's
 * turn bracket (`agent.turn`), and a terminal for sign-in or a conversation's
 * raw view (`agent.open`). The agent knows nothing of it.
 *
 * No Electron import: this loads under plain Node in the tests.
 */
import type { MainPlugin } from '../../../main/plugin-api'
import { CHAT_INFO } from '../info'
import { chatCapabilities, CHAT_NAMESPACES, type OpenResult } from './capabilities'
import { createChats, type CommandTarget } from './chats'

export const chatMain: MainPlugin = {
  info: CHAT_INFO,
  activate(ctx) {
    const turn = (id: string, edge: 'begin' | 'end' | 'forget'): void =>
      void ctx
        .call('agent.turn', { id, edge })
        .catch((err: unknown) => console.error('[chat] turn bracket:', err))
    const chats = createChats({
      userData: ctx.userData,
      emit: ctx.emit,
      target: async () => (await ctx.call('agent.target', {})) as CommandTarget | null,
      turn: (id, active) => turn(id, active ? 'begin' : 'end'),
      gone: (id) => turn(id, 'forget'),
    })
    const open = async (params: Record<string, unknown>): Promise<OpenResult> =>
      (await ctx.call('agent.open', params)) as OpenResult
    ctx.register(
      CHAT_NAMESPACES,
      chatCapabilities({
        chats,
        liveRemote: () => ctx.active()?.remote ?? null,
        target: async () => (await ctx.call('agent.target', {})) as CommandTarget | null,
        openFork: (conversation) => open({ fork: conversation }),
        openLogin: () => open({ login: true }),
      }),
    )
    // Quitting stops every chat's process, so it asks while one works or
    // waits on the person: that turn is cut short.
    ctx.guardQuit(() => {
      const busy = chats.busy()
      if (busy.length === 0) return null
      const one = busy.length === 1
      return {
        message: one ? `Quit and stop ${busy[0]!.title}?` : `Quit and stop ${busy.length} chats?`,
        detail: `${one ? 'Its' : 'Their'} current turn is cut short. The conversation${one ? '' : 's'} stay in the Agents view.`,
      }
    })
    void chats.attach(ctx.remote).catch((err: unknown) => console.error('[chat] attach:', err))
    return async () => {
      await chats.leave().catch((err: unknown) => console.error('[chat] leave:', err))
    }
  },
}
