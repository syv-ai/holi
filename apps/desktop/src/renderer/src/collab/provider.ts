/**
 * Per-doc collab session — bound to **main**, not to the relay (D59).
 *
 * This used to build its own `HocuspocusProvider` straight to the Syv relay, which meant
 * two independent Yjs clients on one machine reaching each other through a server in
 * another country: a keystroke went renderer → relay → main → disk. Offline they were
 * strangers, so an edit never reached main, never reached disk, and died on quit.
 *
 * Now the renderer's Y.Doc links to the doc main already holds. Main materializes it to
 * disk and carries it upstream — both paths it was already wired for. It also ends the
 * one documented exception to "the session token lives only in main" (`session.ts`):
 * `collabAuth` handed the raw token over so the renderer could authenticate to the relay,
 * and there is nothing left to authenticate.
 */
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { YDOC_TEXT_KEY, YjsLink } from '@holi/shared'
import type { SyncStatus } from '@holi/shared'

export interface DocSession {
  ydoc: Y.Doc
  text: Y.Text
  /** A real `y-protocols` Awareness bound to `ydoc` — yCollab reaches through to
   * `awareness.doc.clientID`, so this cannot be a duck-typed stand-in. */
  awareness: Awareness
  setUser(user: { name: string; color: string }): void
  destroy(): void
}

export async function openDoc(docId: string, onStatus: (s: SyncStatus) => void): Promise<DocSession> {
  const ydoc = new Y.Doc()
  const awareness = new Awareness(ydoc)
  onStatus('syncing')

  const link = new YjsLink(ydoc, awareness, {
    sendUpdate: (update) => void window.holi.collab.update(docId, update),
    sendAwareness: (update) => void window.holi.collab.awareness(docId, update),
  })

  const offUpdate = window.holi.collab.onUpdate((e) => {
    if (e.docId === docId) link.applyUpdate(new Uint8Array(e.update))
  })
  const offAwareness = window.holi.collab.onAwareness((e) => {
    if (e.docId === docId) link.applyAwareness(new Uint8Array(e.update))
  })
  const offStatus = window.holi.collab.onStatus((e) => {
    if (e.docId === docId) onStatus(e.status)
  })

  const detach = (): void => {
    offUpdate()
    offAwareness()
    offStatus()
    link.destroy()
  }

  // Subscribe BEFORE opening: main pushes from inside the open call, and a listener
  // attached afterwards would miss whatever landed in between.
  const envelope = await window.holi.collab.open(docId)
  if (!envelope.ok) {
    detach()
    ydoc.destroy()
    throw new Error(envelope.message)
  }
  const { state, awareness: awarenessState, status } = envelope.data as {
    state: Uint8Array
    awareness: Uint8Array | null
    status: SyncStatus
  }
  link.applyUpdate(new Uint8Array(state))
  if (awarenessState) link.applyAwareness(new Uint8Array(awarenessState))
  onStatus(status)

  return {
    ydoc,
    text: ydoc.getText(YDOC_TEXT_KEY),
    awareness,
    setUser: (user) => awareness.setLocalStateField('user', user),
    destroy() {
      // Order is load-bearing. Clearing local state emits synchronously through the
      // still-attached link, so the removal reaches main (and every teammate) before we
      // tear anything down. Detaching first would strand a ghost caret on the doc for
      // everyone else — awareness has no "peer left" event of its own to fall back on.
      awareness.setLocalState(null)
      detach()
      void window.holi.collab.close(docId)
      awareness.destroy()
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
