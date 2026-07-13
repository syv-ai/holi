/**
 * The turn-protocol merge core (spike 2026-07-10, promoted; architecture §3).
 * Used by the desktop bridge at agent-turn end and by the server git ingester.
 * Invariants carried from the spike: never blind-replace; the caller must
 * capture base text + base Yjs state atomically at every materialization, and
 * advance the base before releasing the turn lock.
 */
import diff from 'fast-diff'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from './ydoc'

export const BRIDGE_ORIGIN = 'bridge-merge'

/** diff(base → next) applied as positioned ops onto a LIVE Y.Text that may
 * contain concurrent edits. Positions are computed against `base`; when the
 * live text has diverged, Yjs convergence semantics apply (both texts survive,
 * deterministically ordered). Returns true when the live text had diverged. */
export function applyTextDiff(text: Y.Text, base: string, next: string): boolean {
  const diverged = text.toString() !== base
  let cursor = 0
  // semantic cleanup (4th arg) coalesces fragmented ops so an agent rewrite
  // stays contiguous under concurrent same-range edits — the spike ran
  // diff_cleanupSemantic for exactly this
  for (const [op, chunk] of diff(base, next, undefined, true)) {
    if (op === diff.EQUAL) {
      cursor += chunk.length
    } else if (op === diff.DELETE) {
      // clamp defensively: a diverged live text can be shorter than base
      const len = Math.min(chunk.length, Math.max(0, text.length - cursor))
      if (len > 0) text.delete(cursor, len)
    } else {
      const at = Math.min(cursor, text.length)
      text.insert(at, chunk)
      cursor += chunk.length
    }
  }
  return diverged
}

/**
 * Turn end: fork a shadow doc from the frozen base state, replay diff(base →
 * file) on the shadow (positions are valid there — the shadow IS the base),
 * then merge the shadow's state-vector delta into the live doc. The shadow is
 * a virtual client that went offline at the freeze point and made exactly the
 * agent's edits; Yjs's CRDT merge does the 3-way positional reconciliation.
 * Returns the shadow's post-op state — the agent's file lineage, which the
 * caller needs as the next frozen base if the agent is still writing.
 */
export function applyAgentTurn(
  live: Y.Doc,
  baseState: Uint8Array,
  fileText: string,
): { agentState: Uint8Array } {
  const shadow = new Y.Doc()
  Y.applyUpdate(shadow, baseState)
  const shadowText = shadow.getText(YDOC_TEXT_KEY)
  const baseText = shadowText.toString()
  if (baseText === fileText) {
    shadow.destroy()
    return { agentState: baseState }
  }
  shadow.transact(() => {
    applyTextDiff(shadowText, baseText, fileText)
  })
  const patch = Y.encodeStateAsUpdate(shadow, Y.encodeStateVector(live))
  Y.applyUpdate(live, patch, BRIDGE_ORIGIN)
  const agentState = Y.encodeStateAsUpdate(shadow)
  shadow.destroy()
  return { agentState }
}
