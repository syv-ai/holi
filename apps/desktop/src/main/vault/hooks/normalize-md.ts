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
 *
 * The rule itself lives in `@holi/shared` (`normalizeText`), because the editor
 * has to recognise this transform's own output to avoid reading it as a foreign
 * edit. This module is the filesystem around it.
 */
import { readFile } from 'node:fs/promises'
import { normalizeText, vaultRelPath } from '@holi/shared'
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
