/**
 * The commit-time tidy, as pure text, shared because two places must agree.
 *
 * The hook applies it; the editor must *recognise* it. A transform rewrites the
 * file after the editor's save, breaking `editor-reload.ts`'s invariant that
 * `disk === base` after a save, so Holi's own tidy would read as a foreign (and
 * unmergeable) edit. `decideReload` asks whether `disk` is merely what
 * normalization would make of `base`, and treats that as its own write.
 *
 * That only works because everything here is **idempotent and re-derivable**:
 * discarding it in favour of the buffer loses nothing, since the next commit
 * applies it again. A transform that carries real content (`relink`) is
 * deliberately NOT recognised this way — it still goes through the merge.
 */
import type { SnapshotClaim } from './types'

/** The claims whose files have a canonical form of their own. */
export type Normalizer = Pick<SnapshotClaim, 'match' | 'normalize'>

/** `text` tidied, then put in the canonical form of the first claim in
 *  `normalizers` that matches `path` and has one. */
export function normalizeText(
  text: string,
  path: string,
  normalizers: readonly Normalizer[],
): string {
  // **CRLF is left entirely alone.** Rewriting a Windows collaborator's line
  // endings would change every line in the diff.
  if (text.includes('\r')) return text

  const tidied = tidyWhitespace(text)
  const claim = normalizers.find((c) => c.normalize !== undefined && c.match(path))
  return claim?.normalize !== undefined ? claim.normalize(tidied) : tidied
}

/** A line that is only block markup waiting for its text: a bullet, number or
 *  letter marker (a task's box included), or a heading's `#`s, under any
 *  quote markers and indent. */
const BARE_MARKER =
  /^[ \t]*(?:>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)]|[A-Za-z][.)])(?:[ \t]+\[[ xX]?\])?|#{1,6})[ \t]+$/

/**
 * Trailing whitespace off, exactly one final newline on — outside code fences.
 *
 * **Two trailing spaces are preserved**: in markdown that is a hard line break.
 * **So is the space after a bare marker** (`- `, `1. `, `a. `, `# `).
 */
function tidyWhitespace(text: string): string {
  const lines = text.split('\n')
  let inFence = false
  let fenceMarker = ''

  const out = lines.map((line) => {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      const marker = fence[1]![0]!
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (marker === fenceMarker) {
        inFence = false
      }
      return line
    }
    // Inside a fence the whitespace IS the content — indentation in a code
    // sample, a deliberate trailing space in a diff.
    if (inFence) return line
    // An empty list item or heading keeps the one space after its marker:
    // without it `a.` is not an item and `#` followed by text is not a
    // heading, so the tidy would change what the line is.
    if (BARE_MARKER.test(line)) return line.replace(/[ \t]+$/, ' ')
    if (/\S {2,}$/.test(line)) return line // a hard line break
    return line.replace(/[ \t]+$/, '')
  })

  const joined = out.join('\n')
  // An unterminated fence means the file is mid-edit and we cannot tell content
  // from formatting. Leave the ending alone rather than guess.
  if (inFence) return joined
  return joined.endsWith('\n') ? joined.replace(/\n+$/, '\n') : `${joined}\n`
}
