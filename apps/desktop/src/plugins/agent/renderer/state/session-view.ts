/**
 * Sessions as the Agents view shows them: in a terminal of the view's own, so
 * a session's window there never fights a Documents tab for the same xterm.
 * A new session starts here, in the default agent unless one is picked, and
 * lands in the view.
 */
import { atom } from 'jotai'
import type { AgentProviderId } from '@holi/shared'
import {
  activeRemoteAtom,
  appModeAtom,
  openNextBeside,
  type ConversationContext,
  type ConversationStart,
} from '@/plugin-api'
import { agentCap } from '../agent-cap'
import { agentsViewAtom, viewTerminalsAtom } from './agents-view'
import { newSessionProviderAtom, providerLabel } from './providers'
import { agentGeometryAtom, agentHistoryAtom } from './sessions'
import { respawnSessionAtom, type AgentResult } from './send'
import { toast } from 'sonner'

/** The line an ask opens with for each app it is about: the agent reads the
 *  app's folder itself, in the clone, with its own permissions.
 * @public exported for its test
 */
export function contextLine(item: ConversationContext): string {
  return `This is about the vault app "${item.name}", the folder ${item.path} (its page is index.html, its manifest app.yaml).`
}

/**
 * The first message: a line per context item, then the ask.
 * @public exported for its test
 */
export function withContext(
  text: string,
  context: readonly ConversationContext[] | undefined,
): string {
  if (context === undefined || context.length === 0) return text
  const lines = context.map(contextLine).join('\n')
  return text.trim() === '' ? lines : `${lines}\n\n${text}`
}

/** A session started, or why not. */
export type StartedResult = { ok: true; sessionId: string } | { ok: false; message: string }

/**
 * A new session in the view, of `provider` (the machine's default when
 * omitted): with a `prompt` that is its first turn, with `resume` it picks up
 * a conversation of that agent's. Its terminal opens in the view, and a
 * failure says so in a toast as well as in the answer.
 */
export const startViewSessionAtom = atom(
  null,
  async (
    get,
    set,
    args: { provider?: AgentProviderId; prompt?: string; resume?: string; beside?: boolean } = {},
  ): Promise<StartedResult> => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return { ok: false, message: 'No vault is open.' }
    const provider = args.provider ?? get(newSessionProviderAtom)
    const prompt = args.prompt?.trim()
    const res = await agentCap.start(remote, {
      provider,
      ...(prompt ? { prompt, name: prompt } : {}),
      ...(args.resume === undefined ? {} : { resume: args.resume }),
      ...get(agentGeometryAtom),
    })
    if (!res.ok) {
      toast.error(`Couldn't start ${providerLabel(provider)}. ${res.message}`)
      return res
    }
    set(viewTerminalsAtom, (t) => ({ ...t, [res.sessionId]: res.terminalId }))
    if (args.beside) openNextBeside()
    set(appModeAtom, 'agents')
    set(agentsViewAtom, { kind: 'session', id: res.sessionId })
    return { ok: true, sessionId: res.sessionId }
  },
)

/**
 * The Agents slot's `start` (the command menu's Ask the agent, an app card's
 * Ask about this app): a new session in the default agent whose first turn
 * is the text, its context named ahead of it. With only context, the context
 * goes in unsent, for the person to finish the ask.
 */
export const startConversationViewAtom = atom(
  null,
  async (get, set, start: ConversationStart): Promise<AgentResult> => {
    const beside = start.beside ? { beside: true } : {}
    if (start.text.trim() !== '') {
      const res = await set(startViewSessionAtom, {
        prompt: withContext(start.text, start.context),
        ...beside,
      })
      return res.ok ? { ok: true } : res
    }
    const res = await set(startViewSessionAtom, beside)
    if (!res.ok) return res
    const context = withContext('', start.context)
    const remote = get(activeRemoteAtom)
    if (context === '' || remote === null) return { ok: true }
    const sent = await agentCap.send(remote, { text: `${context}\n\n`, target: res.sessionId })
    return sent.ok ? { ok: true } : sent
  },
)

/** Show a session in the Agents view (a plugin's run, through the agent
 *  service): live, as it is; finished, brought back with `claude respawn`
 *  first, its conversation intact. */
export const showSessionAtom = atom(
  null,
  async (get, set, args: { session: string; live: boolean }): Promise<AgentResult> => {
    const ownPast = get(agentHistoryAtom).some(
      (row) => row.id === args.session && /^p[0-9a-f]{12}$/.test(row.id),
    )
    if (!args.live && !ownPast) {
      const res = await set(respawnSessionAtom, args.session)
      if (!res.ok) return res
    }
    set(appModeAtom, 'agents')
    set(agentsViewAtom, { kind: 'session', id: args.session })
    return { ok: true }
  },
)
