import DiffMatchPatch from 'diff-match-patch'
import * as Y from 'yjs'

const dmp = new DiffMatchPatch()

export const BRIDGE_ORIGIN = 'bridge-merge'

/**
 * D25 turn end: apply what the agent changed (diff of frozen base → file) as
 * positioned Yjs ops onto the live doc, which may hold buffered remote edits.
 *
 * Implementation: fork a shadow doc from the frozen base state, replay the
 * text diff as Y.Text ops on the shadow (positions are valid there — the
 * shadow IS the base), then merge the shadow's delta into the live doc.
 * The shadow acts as a virtual client that went offline at the freeze point;
 * Yjs's own CRDT merge performs the 3-way positional reconciliation.
 * Never blind-replace (D2/D25).
 */
export function applyAgentTurn(
  live: Y.Doc,
  baseState: Uint8Array,
  fileText: string,
): { agentState: Uint8Array } {
  const shadow = new Y.Doc()
  Y.applyUpdate(shadow, baseState)
  const shadowText = shadow.getText('content')
  const baseText = shadowText.toString()
  if (baseText === fileText) {
    shadow.destroy()
    return { agentState: baseState }
  }

  const diffs = dmp.diff_main(baseText, fileText)
  dmp.diff_cleanupSemantic(diffs)

  shadow.transact(() => {
    let pos = 0
    for (const [op, chunk] of diffs) {
      if (op === DiffMatchPatch.DIFF_EQUAL) {
        pos += chunk.length
      } else if (op === DiffMatchPatch.DIFF_DELETE) {
        shadowText.delete(pos, chunk.length)
      } else {
        shadowText.insert(pos, chunk)
        pos += chunk.length
      }
    }
  })

  const patch = Y.encodeStateAsUpdate(shadow, Y.encodeStateVector(live))
  Y.applyUpdate(live, patch, BRIDGE_ORIGIN)
  // The shadow's post-op state IS the agent's file lineage (base + agent ops) —
  // the caller needs it as the next frozen base if the agent is still writing.
  const agentState = Y.encodeStateAsUpdate(shadow)
  shadow.destroy()
  return { agentState }
}
