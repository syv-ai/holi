/**
 * Vault content, written out to a folder on disk (`prd/notes-editor.md` FR-13).
 *
 * The mirror of `import-files.ts`, and the two differ in exactly one decided
 * way. Importing refuses a colliding name (`COPYFILE_EXCL`) because the vault's
 * standing rule is refuse-rather-than-overwrite. Exporting **auto-renames**,
 * using the same " copy" rule as Duplicate: the destination is the user's own
 * disk, a second copy is the useful outcome, and silently replacing a file
 * there is the one thing in this app git could not undo.
 *
 * Folders are copied whole. `import-files` refuses them because recursing INTO
 * the vault raises a question about what a folder of unknown files becomes;
 * going out, a folder is just a folder.
 */
import { cp, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { freeCopyPath, vaultRelPath } from '@holi/shared'
import { absPathFor } from './vault-files'
import { reasonFor } from './import-files'

export interface ExportResult {
  /** What actually landed: the vault-relative source, and where it went. The
   *  caller needs this separately from `failed` because a MOVE deletes only
   *  what is in here. */
  landed: { from: string; to: string }[]
  failed: { name: string; reason: string }[]
}

/** True when something already occupies `abs`. */
async function exists(abs: string): Promise<boolean> {
  try {
    await stat(abs)
    return true
  } catch {
    return false
  }
}

/**
 * The free name for `name` inside `destDir`.
 *
 * `freeCopyPath` asks a SYNCHRONOUS predicate and existence on disk is async,
 * so this walks the candidate sequence the rule generates, probing each one and
 * feeding what it found back in as the `taken` set. The rule stays the single
 * authority on what " copy 2" means — a second implementation of that naming
 * here would be one too many, and would drift from Duplicate.
 */
async function freeNameIn(destDir: string, name: string): Promise<string> {
  const taken = new Set<string>()
  let candidate = join(destDir, name)
  for (let guard = 0; guard < 1000; guard++) {
    if (!(await exists(candidate))) return candidate
    taken.add(candidate)
    candidate = freeCopyPath((p) => taken.has(p), join(destDir, name))
  }
  return candidate
}

/**
 * Copy each of `targets` (vault-relative files or folders) into `destDir`.
 *
 * `destDir` is absolute and outside the vault — it comes from a native folder
 * chooser, so it is the user's own choice rather than anything derived here.
 * The SOURCES are validated: `vaultRelPath` throws on a path that climbs out,
 * which is what stops a caller reading arbitrary disk.
 */
export async function exportFiles(
  root: string,
  targets: string[],
  destDir: string,
): Promise<ExportResult> {
  const landed: { from: string; to: string }[] = []
  const failed: { name: string; reason: string }[] = []

  for (const target of targets) {
    // Throws on a path that climbs out of the vault, and deliberately NOT
    // caught: that is a programming error, not a per-file failure to report.
    const source = absPathFor(root, vaultRelPath(target))
    const name = basename(target)
    try {
      // Resolved per target inside the loop, so exporting two files of the same
      // name in one go lands both — the second sees what the first just wrote.
      const to = await freeNameIn(destDir, name)
      // `recursive` so a folder target keeps its shape. No `force`/`errorOnExist`:
      // `freeNameIn` has already established that `to` is unoccupied.
      await cp(source, to, { recursive: true })
      landed.push({ from: target, to })
    } catch (err) {
      failed.push({ name, reason: reasonFor((err as NodeJS.ErrnoException).code) })
    }
  }
  return { landed, failed }
}
