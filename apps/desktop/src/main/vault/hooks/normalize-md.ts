/**
 * `normalize-md`: safe, idempotent, invisible changes only.
 *
 * **No prose reflow, ever.** Autosave plus auto-commit means this fires on a
 * file the user is typing in, and anything that moves text moves their cursor.
 * The list is trailing whitespace, a missing final newline, and a task file's
 * canonical frontmatter; a fourth item has to argue for itself.
 *
 * **Staged set only**, never the whole vault, so one save is never a
 * hundred-file diff. The rule lives in `@holi/shared` (`normalizeText`) because
 * the editor must recognise this transform's output as not a foreign edit.
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
