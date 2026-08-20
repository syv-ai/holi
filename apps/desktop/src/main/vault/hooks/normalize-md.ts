/**
 * `normalize-md` — safe, idempotent, invisible changes only.
 *
 * **No prose reflow, ever.** The editor autosaves and Holi auto-commits, so
 * this fires on a file the user has open, mid-sentence, while they are typing
 * in it. Anything that moves text moves their cursor. This repo's own memory
 * records that `prettier --write` corrupts it; a vault's notes deserve more
 * caution than a codebase, not less.
 *
 * Everything here is a change the author would not have noticed themselves
 * making, and would not notice being made: trailing whitespace, a missing final
 * newline, and a task file's frontmatter key order. That is the entire list, and
 * a fourth item should have to argue for itself against this paragraph.
 *
 * It works on the **staged set only**, never the whole vault — a transform that
 * rewrites files nobody was editing turns one save into a hundred-file diff.
 */
import { readFile } from 'node:fs/promises'
import {
  isTaskFilePath,
  parseTaskFile,
  serializeTaskFile,
  vaultRelPath,
} from '@holi/shared'
import { absPathFor, writeAtomic } from '../vault-files'
import type { StagedChanges } from './staged'
import type { TransformResult } from './relink'

export async function normalizeMd(
  root: string,
  staged: StagedChanges,
): Promise<TransformResult> {
  const targets = [...staged.added, ...staged.modified, ...staged.renamed.map((r) => r.to)]
  const changed: string[] = []

  for (const path of [...new Set(targets)].sort()) {
    if (!path.endsWith('.md')) continue
    const rel = vaultRelPath(path)
    const text = await readFile(absPathFor(root, rel), 'utf8').catch(() => null)
    if (text === null) continue

    const next = normalizeText(text, path)
    if (next === text) continue
    await writeAtomic(root, rel, next)
    changed.push(path)
  }

  return {
    changed,
    notes: changed.length === 0 ? [] : [`normalize-md: tidied ${changed.length} file(s)`],
  }
}

/** Exported for the unit tests that care about the text rule rather than the
 *  filesystem around it. */
export function normalizeText(text: string, path: string): string {
  // **CRLF is left entirely alone.** A Windows collaborator's line endings are
  // not a defect in their file, and rewriting them would show up as every line
  // changed in a diff nobody asked for. Bailing out wholesale is simpler and
  // safer than trying to normalize within them.
  if (text.includes('\r')) return text

  const tidied = tidyWhitespace(text)
  return isTaskFilePath(path) ? canonicalizeTask(tidied) : tidied
}

/**
 * Trailing whitespace off, exactly one final newline on — outside code fences.
 *
 * **Two trailing spaces are preserved**: in markdown that is a hard line break,
 * so stripping it is not tidying, it silently changes how the note renders.
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
 *  Unparseable means not ours to touch — `parseTaskFile` throws for a value
 *  that is present and wrong, and that is a thing to surface, not to rewrite. */
function canonicalizeTask(text: string): string {
  try {
    return serializeTaskFile(parseTaskFile(text, 'task.x.md'))
  } catch {
    return text
  }
}
