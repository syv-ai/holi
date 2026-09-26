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
import { isTaskFilePath, parseTaskFile, serializeTaskFile } from './task-file'

export function normalizeText(text: string, path: string): string {
  // **CRLF is left entirely alone.** Rewriting a Windows collaborator's line
  // endings would change every line in the diff.
  if (text.includes('\r')) return text

  const tidied = tidyWhitespace(text)
  return isTaskFilePath(path) ? canonicalizeTask(tidied) : tidied
}

/**
 * Trailing whitespace off, exactly one final newline on — outside code fences.
 *
 * **Two trailing spaces are preserved**: in markdown that is a hard line break.
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
    if (/\S {2,}$/.test(line)) return line // a hard line break
    return line.replace(/[ \t]+$/, '')
  })

  const joined = out.join('\n')
  // An unterminated fence means the file is mid-edit and we cannot tell content
  // from formatting. Leave the ending alone rather than guess.
  if (inFence) return joined
  return joined.endsWith('\n') ? joined.replace(/\n+$/, '\n') : `${joined}\n`
}

/** A task file's frontmatter, in the order `serializeTaskFile` writes it.
 *  Unparseable means not ours to touch: a value that is present and wrong is a
 *  thing to surface, not to rewrite. */
function canonicalizeTask(text: string): string {
  try {
    return serializeTaskFile(parseTaskFile(text, 'task.x.md'))
  } catch {
    return text
  }
}
