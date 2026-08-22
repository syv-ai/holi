/**
 * Bringing files in from outside the vault — the drop from Finder
 * (`prd/notes-editor.md` FR-13).
 *
 * A vault is a folder, so an import is a copy. Two things make it unlike
 * `copyNotes`, which moves files that are already inside:
 *
 * - **It copies bytes.** `copyNotes` reads utf8 because everything it touches
 *   is vault content and already text. This is the door an image or a PDF comes
 *   through, and reading one as utf8 corrupts it silently.
 * - **The name is not chosen by the person dropping** — it comes from whatever
 *   folder the file was in — so a collision is the common case rather than the
 *   careless one. The vault's standing rule applies (FR-11): refuse rather than
 *   overwrite. Per file, though, not per drop: dropping six files and getting
 *   nothing because the fourth clashed is what makes people drop one at a time.
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { vaultRelPath } from '@holi/shared'
import { absPathFor } from './vault-files'

export interface ImportResult {
  /** Vault-relative paths that landed. */
  imported: string[]
  skipped: { name: string; reason: string }[]
}

/** A failure a person caused, in words. Anything else keeps its code, because a
 *  reason nobody predicted is better shown than paraphrased. */
const REASONS: Record<string, string> = {
  EEXIST: 'a file of that name is here',
  // Dragging a folder in is an ordinary thing to try. Recursing is a feature;
  // saying what happened is the minimum. macOS answers `ENOTSUP` rather than
  // the `EISDIR` you would guess — measured, not assumed.
  ENOTSUP: 'folders are not imported yet',
  EISDIR: 'folders are not imported yet',
  EPERM: 'folders are not imported yet',
  EACCES: 'no permission to read it',
}

export async function importFiles(
  root: string,
  sources: string[],
  destFolder: string,
): Promise<ImportResult> {
  const imported: string[] = []
  const skipped: { name: string; reason: string }[] = []

  for (const source of sources) {
    const name = basename(source)
    const rel = vaultRelPath(destFolder === '' ? name : `${destFolder}/${name}`)
    const abs = absPathFor(root, rel)
    await mkdir(dirname(abs), { recursive: true })
    try {
      // `COPYFILE_EXCL`: the refusal is the filesystem's, not a check followed
      // by a write — nothing can land in the gap between them.
      await copyFile(source, abs, 1 /* fs.constants.COPYFILE_EXCL */)
      imported.push(rel)
    } catch (err) {
      // An unmapped code is CARRIED, not paraphrased away. "could not be
      // copied" on its own tells the person only that the thing they watched
      // not happen did not happen — nothing to act on, and nothing to report
      // to whoever could fix it. The map covers the failures a person causes;
      // the code covers the ones nobody predicted, which is the whole reason
      // for having a fallback at all.
      const code = (err as NodeJS.ErrnoException).code
      const known = REASONS[code ?? '']
      skipped.push({
        name,
        reason: known ?? (code ? `could not be copied (${code})` : 'could not be copied'),
      })
    }
  }
  return { imported, skipped }
}
