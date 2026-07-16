/**
 * Per-doc collab session: Y.Doc + HocuspocusProvider (room name = docId,
 * server-data PRD §Yjs persistence). Credentials come from main per
 * connection and live only in this closure (plan decision #1).
 */
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import type { SyncStatus } from '@holi/shared'

export interface DocSession {
  ydoc: Y.Doc
  text: Y.Text
  provider: HocuspocusProvider
  destroy(): void
}

export async function openDoc(docId: string, onStatus: (s: SyncStatus) => void): Promise<DocSession> {
  const auth = await window.holi.collabAuth()
  if (!auth) throw new Error('not signed in')
  const ydoc = new Y.Doc()
  onStatus('syncing')
  const provider = new HocuspocusProvider({
    url: auth.url,
    name: docId,
    token: auth.token,
    document: ydoc,
    onSynced: () => onStatus('synced'),
    onDisconnect: () => onStatus('offline'),
    onStatus: ({ status }) => {
      if (status === 'connecting') onStatus('syncing')
    },
  })
  return {
    ydoc,
    text: ydoc.getText(YDOC_TEXT_KEY),
    provider,
    destroy() {
      provider.destroy()
      ydoc.destroy()
    },
  }
}

/**
 * Is an agent mid-write on this doc? The consumer of `agentEditing`, which main's
 * vault-mirror has published since D37 (`vault-mirror.ts` `onTurnState`) and nothing
 * ever read — while the agent's own system prompt told it the marker was on screen.
 *
 * The publisher is a *main* process, not a renderer: main holds its own
 * HocuspocusProvider per mirrored doc, in the same room, and stamps the field for the
 * span of an agent turn. So the state we match here is never our own — a renderer only
 * ever sets `user` — and the localClientId skip is belt-and-braces rather than load-bearing.
 *
 * **Any agent, not just ours** — and deliberately. Main stamps `agentEditing` with no
 * identity attached, so a teammate's agent editing a shared doc is indistinguishable from
 * ours here. That is not a shortfall: `prd/agent.md` wants it both ways at once — the
 * drawer's question is "what is my own agent doing to this doc" (§Presence, D37), and the
 * user story is "while it works, **teammates** see 'Claude is editing…' on the doc". A
 * marker that fires for whichever agent is writing satisfies both readings; one filtered
 * to our own client would break the second.
 */
export function agentEditingIn(
  states: Iterable<[number, Record<string, unknown>]>,
  localClientId: number,
): boolean {
  for (const [clientId, state] of states) {
    if (clientId === localClientId) continue
    if (state['agentEditing'] === true) return true
  }
  return false
}

/** Deterministic presence color per user (D20). */
export function presenceColor(userId: string): string {
  const palette = ['#f97316', '#22d3ee', '#a3e635', '#e879f9', '#facc15', '#38bdf8', '#fb7185', '#4ade80']
  let hash = 0
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return palette[Math.abs(hash) % palette.length]!
}
