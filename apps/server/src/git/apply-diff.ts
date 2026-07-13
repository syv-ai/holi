/** The server-side D25 shape: diff(base, next) applied as positioned ops onto
 * a LIVE Y.Text that may contain concurrent edits. Positions are computed
 * against `base`; when the live text has diverged, Yjs convergence semantics
 * apply (both texts survive; spike-verified — docs/spikes/2026-07-10-bridge-
 * turn-protocol.md). Callers snapshot before calling and surface a warning on
 * divergence. Returns true when the live text had diverged from base. */
import diff from 'fast-diff'
import type * as Y from 'yjs'

export function applyTextDiff(text: Y.Text, base: string, next: string): boolean {
  const diverged = text.toString() !== base
  let cursor = 0
  for (const [op, chunk] of diff(base, next)) {
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
