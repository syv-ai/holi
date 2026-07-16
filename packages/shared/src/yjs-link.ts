/**
 * A symmetric Yjs peer link over an opaque transport (D59).
 *
 * Two Yjs peers on one machine — the Electron **renderer** (which holds the open doc and
 * the editor) and **main** (which holds every doc, the working copy, and the one upstream
 * connection to the relay). Before this, both were independent clients of the *remote*
 * relay, so a keystroke travelled renderer → relay → main → disk, and offline they were
 * strangers: main never saw the edit, so it never hit disk, so it died on quit.
 *
 * **It is one class used by both ends, not two halves.** The link is genuinely
 * symmetric — each side forwards what it did not receive, and applies what it did — and
 * the loop guard only works if both ends agree on the tag. Two implementations would be
 * two chances to disagree about the one invariant holding the whole thing up.
 *
 * Deliberately transport-free: no IPC, no Electron, no fs. It takes a `Y.Doc`, an
 * `Awareness` and a `send`, which is what makes the echo suppression testable headlessly
 * against two real docs — the only property here worth being sure about.
 */
import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness'

/**
 * Tags an update as *arrived from the peer*. Both ends apply with it and both ends skip
 * it when forwarding — that symmetry IS the loop guard. `Symbol.for` rather than a bare
 * symbol so the tag survives a bundle boundary: main and the renderer are separate
 * bundles, and two distinct symbols would compare unequal, forwarding every update
 * straight back and looping forever.
 */
export const PEER_ORIGIN = Symbol.for('holi.yjs-link.peer')

export interface YjsLinkTransport {
  sendUpdate(update: Uint8Array): void
  sendAwareness(update: Uint8Array): void
}

export class YjsLink {
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void
  private readonly onAwarenessUpdate: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void

  constructor(
    private readonly doc: Y.Doc,
    private readonly awareness: Awareness | null,
    transport: YjsLinkTransport,
  ) {
    this.onDocUpdate = (update, origin) => {
      // Anything the peer sent us, the peer already has. Everything else it needs —
      // including BRIDGE_ORIGIN, which is the agent's file write showing up live in the
      // editor. Skipping non-peer origins here would silently make the agent invisible.
      if (origin === PEER_ORIGIN) return
      transport.sendUpdate(update)
    }
    this.doc.on('update', this.onDocUpdate)

    this.onAwarenessUpdate = ({ added, updated, removed }, origin) => {
      if (origin === PEER_ORIGIN) return
      const changed = [...added, ...updated, ...removed]
      if (changed.length === 0) return
      // Removals ride the same encoder — it writes a null state against the client's
      // existing clock, which is how the peer learns a cursor went away rather than
      // leaving a ghost caret behind.
      transport.sendAwareness(encodeAwarenessUpdate(this.awareness!, changed))
    }
    if (this.awareness) this.awareness.on('update', this.onAwarenessUpdate)
  }

  /** Everything the doc knows, as one update — the peer's opening state.
   *
   * A full state rather than a state-vector handshake: the peer's doc is always freshly
   * constructed when it links, so there is nothing on its side for us to diff against and
   * the two-step exchange would only buy bytes. Revisit if a peer ever links to a doc it
   * has already populated (e.g. from local persistence). */
  stateAsUpdate(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc)
  }

  /** Every awareness state we currently know, or null when nobody is present. The peer
   * gets this once on link: awareness only emits on *change*, so a cursor or an agent
   * turn that predates the link would otherwise be invisible until it moved. */
  awarenessAsUpdate(): Uint8Array | null {
    if (!this.awareness) return null
    const clients = [...this.awareness.getStates().keys()]
    return clients.length > 0 ? encodeAwarenessUpdate(this.awareness, clients) : null
  }

  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, PEER_ORIGIN)
  }

  applyAwareness(update: Uint8Array): void {
    if (this.awareness) applyAwarenessUpdate(this.awareness, update, PEER_ORIGIN)
  }

  /** Detach. Does NOT destroy the doc or the awareness — the link owns neither, and on
   * main both outlive every renderer that links to them. */
  destroy(): void {
    this.doc.off('update', this.onDocUpdate)
    if (this.awareness) this.awareness.off('update', this.onAwarenessUpdate)
  }
}
