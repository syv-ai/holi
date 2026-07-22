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

/**
 * One region where both sides changed overlapping base lines.
 *
 * All three slices are carried, because the reconcile prompt is built from them:
 * "here is what it was, here is what you wrote, here is what arrived" is the
 * question the agent has to answer, and two of the three is not enough of it.
 */
export interface ConflictRegion {
  /** Offsets are 0-based and index each side's **own** line array, so a caller
   * can highlight the region in the buffer it already holds. */
  base: { start: number; lines: string[] }
  mine: { start: number; lines: string[] }
  theirs: { start: number; lines: string[] }
}

/**
 * Mirrors `PullResult`'s shape on purpose — one conflict story, whatever
 * produced it.
 *
 * A conflict carries **no text**. That is the same rule `pull()` follows
 * (vaults-sync FR-12): a conflict must never put markers in a file someone is
 * typing into. The editor keeps the buffer exactly as it is, stops autosaving
 * it, and shows the banner.
 */
export type Merge3Result =
  | { kind: 'merged'; text: string }
  | { kind: 'conflict'; regions: ConflictRegion[] }

/**
 * `base` is the text last loaded or saved, `mine` is the buffer, `theirs` is
 * what is now on disk.
 *
 * Total: it never throws for content. Every caller is an editor holding unsaved
 * work, and a throw there has no honest handler.
 */
export function merge3(base: string, mine: string, theirs: string): Merge3Result {
  const b = base.split('\n')
  const m = mine.split('\n')
  const t = theirs.split('\n')

  const mineHunks = lineHunks(b, m)
  const theirsHunks = lineHunks(b, t)

  // Out of code units to encode lines with. Conflict the whole document rather
  // than merge part of it: it routes to reconcile, loses nothing, and never
  // corrupts.
  if (mineHunks === null || theirsHunks === null) {
    return {
      kind: 'conflict',
      regions: [
        {
          base: { start: 0, lines: b },
          mine: { start: 0, lines: m },
          theirs: { start: 0, lines: t },
        },
      ],
    }
  }

  const all: Tagged[] = [
    ...mineHunks.map((h): Tagged => ({ ...h, side: 'mine' })),
    ...theirsHunks.map((h): Tagged => ({ ...h, side: 'theirs' })),
  ].sort((x, y) => x.start - y.start || x.end - y.end)

  const out: string[] = []
  const regions: ConflictRegion[] = []
  let cursor = 0
  // How far each side's line numbering has drifted from base's, so a region can
  // report an offset into the array its caller actually holds.
  let driftMine = 0
  let driftTheirs = 0

  for (let i = 0; i < all.length; ) {
    // Greedily grow a group while the next hunk overlaps anything already in
    // it. Two hunks from the same side never overlap, so a group spans both
    // sides exactly when they genuinely disagree about the same lines.
    const group: Tagged[] = [all[i]!]
    let hi = all[i]!.end
    let j = i + 1
    while (j < all.length && group.some((g) => overlaps(g, all[j]!))) {
      group.push(all[j]!)
      hi = Math.max(hi, all[j]!.end)
      j++
    }
    const lo = group[0]!.start

    out.push(...b.slice(cursor, lo))

    const ours = group.filter((h) => h.side === 'mine')
    const theirsGroup = group.filter((h) => h.side === 'theirs')

    if (ours.length === 0 || theirsGroup.length === 0) {
      // One side changed this region and the other did not. Take the change.
      out.push(...applyWithin(b, lo, hi, group))
    } else {
      const mineText = applyWithin(b, lo, hi, ours)
      const theirsText = applyWithin(b, lo, hi, theirsGroup)

      if (sameLines(mineText, theirsText)) {
        // Both made the identical edit — the common case when you save and the
        // same content arrives from a pull. A banner here would sit on a file
        // that is already right.
        out.push(...mineText)
      } else {
        regions.push({
          base: { start: lo, lines: b.slice(lo, hi) },
          mine: { start: lo + driftMine, lines: mineText },
          theirs: { start: lo + driftTheirs, lines: theirsText },
        })
      }
    }

    for (const h of ours) driftMine += h.lines.length - (h.end - h.start)
    for (const h of theirsGroup) driftTheirs += h.lines.length - (h.end - h.start)

    cursor = hi
    i = j
  }

  if (regions.length > 0) return { kind: 'conflict', regions }

  out.push(...b.slice(cursor))
  return { kind: 'merged', text: out.join('\n') }
}

interface Tagged extends Hunk {
  side: 'mine' | 'theirs'
}

/**
 * Do these two edits fight over the same base lines?
 *
 * Ranges must **properly overlap** — merely touching is not enough, which is
 * the divergence from git described at the top of this file.
 *
 * The exception is two insertions at the same point. Both are zero-width, so
 * the range test says no; but there is no defensible order to put them in, and
 * inventing one silently interleaves two people's text. Git calls this add/add
 * and so do we.
 */
function overlaps(a: Hunk, b: Hunk): boolean {
  const aEmpty = a.start === a.end
  const bEmpty = b.start === b.end
  if (aEmpty && bEmpty) return a.start === b.start
  return a.start < b.end && b.start < a.end
}

/** What `hunks` turn `base[lo, hi)` into. */
function applyWithin(base: string[], lo: number, hi: number, hunks: Hunk[]): string[] {
  const out: string[] = []
  let cursor = lo
  for (const h of [...hunks].sort((x, y) => x.start - y.start)) {
    out.push(...base.slice(cursor, h.start), ...h.lines)
    cursor = Math.max(cursor, h.end)
  }
  out.push(...base.slice(cursor, hi))
  return out
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i])
}
