/**
 * A 3-way text merge that **reports conflicts rather than resolving them**.
 *
 * The file under an editor can change while the buffer is dirty: the agent
 * wrote it, a pull landed it, or another window touched it. `base` is the text
 * last loaded or saved, `mine` is the buffer, `theirs` is what is now on disk.
 *
 * The report is the feature. A merger that silently picks a side would remove
 * it (`prd/notes-editor.md` §External writes), because the whole point is to
 * route an unmergeable overlap to the same reconcile path a git conflict uses.
 *
 * **Line granularity, not character.** `fast-diff` is used here purely as an
 * LCS engine over lines. Merging two edits *inside one paragraph* at character
 * level produces a sentence neither person wrote, silently — which is worse
 * than a banner, because nobody will look at it again. The cost is real: edit a
 * long paragraph while the agent appends to that same paragraph and this
 * conflicts. That is the right answer anyway.
 *
 * **Adjacent edits merge — a deliberate divergence from git.** Git conflicts
 * when two changed lines are neighbours, because its merge needs an unchanged
 * line between two changes to call them independent hunks. That is an artifact
 * of its three-line context model, not a claim about meaning, and there is no
 * reason to import it: someone typing at line 10 while the agent edits line 11
 * should not get a banner. Hunks here conflict when their base ranges
 * **overlap**, not when they touch.
 */
import diff from 'fast-diff'

/**
 * A replacement of `base[start, end)` with `lines`.
 *
 * An insertion has `start === end`; a deletion has an empty `lines`.
 * Exported for its tests — `merge3` is the interface callers want.
 */
export interface Hunk {
  start: number
  end: number
  lines: string[]
}

/**
 * `fast-diff` compares UTF-16 code units, so line mode means giving each
 * distinct line its own code unit. That caps us at one alphabet's worth of
 * *distinct* lines, and the surrogate range must be skipped: a lone surrogate
 * can be normalised away by an ordinary string operation.
 */
const SURROGATE_START = 0xd800
const SURROGATE_END = 0xdfff
const MAX_CODE_UNIT = 0xffff

/**
 * Diff two line arrays into ordered, non-overlapping hunks.
 *
 * Returns `null` when the two texts hold more distinct lines than there are
 * code units to encode them with. `merge3` turns that into a whole-document
 * conflict: it routes to reconcile, loses nothing, and never corrupts. A note
 * with sixty thousand distinct lines is not a note anyone is editing.
 */
export function lineHunks(base: string[], other: string[]): Hunk[] | null {
  const code = new Map<string, string>()
  const line = new Map<string, string>()
  let next = 0

  const encode = (lines: string[]): string | null => {
    let out = ''
    for (const text of lines) {
      let ch = code.get(text)
      if (ch === undefined) {
        if (next === SURROGATE_START) next = SURROGATE_END + 1
        if (next > MAX_CODE_UNIT) return null
        ch = String.fromCharCode(next++)
        code.set(text, ch)
        line.set(ch, text)
      }
      out += ch
    }
    return out
  }

  const a = encode(base)
  const b = encode(other)
  if (a === null || b === null) return null

  // No cleanup pass. `cleanupSemantic` coalesces character runs for human
  // readability, which would be nonsense in an encoding where one character
  // is one whole line.
  const ops = diff(a, b)

  const hunks: Hunk[] = []
  let cursor = 0
  let pending: Hunk | null = null

  for (const [op, text] of ops) {
    if (op === diff.EQUAL) {
      // A delete and the insert beside it are one replacement, so a pending
      // hunk is flushed only on an EQUAL. Flushing per op would emit a
      // rewritten line as a deletion and an insertion that the merge could
      // not recognise as the same edit.
      if (pending !== null) {
        hunks.push(pending)
        pending = null
      }
      cursor += text.length
      continue
    }

    pending ??= { start: cursor, end: cursor, lines: [] }

    if (op === diff.DELETE) {
      cursor += text.length
      pending.end = cursor
    } else {
      for (const ch of text) pending.lines.push(line.get(ch)!)
    }
  }
  if (pending !== null) hunks.push(pending)

  return hunks
}
