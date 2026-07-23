/**
 * Daily notes, main-side (`daily-notes.md`). The server going away made this
 * small: creating today's note is `if (!exists) write(seed)`, and the guarantee
 * that two of your devices don't mint two notes for one day is the deterministic
 * path + deterministic seed, not a server upsert.
 *
 * The sweep is the only place a background process rewrites the vault's shape,
 * so it reuses the standard rename move (link rewrite included) and its caller
 * batches it into one commit.
 */
import { readFile } from 'node:fs/promises'
import {
  buildDailyNoteContent,
  dailyNoteFilename,
  isDailyNote,
  isUntouchedDailyNote,
  vaultRelPath,
} from '@holi/shared'
import { scanBackrefs } from './backrefs'
import { renameNote } from './rename'
import { absPathFor, listFiles, removeDocFile, writeAtomic } from './vault-files'

/** Create today's `DD-MM-YYYY.md` at the root if absent, else return it. The
 *  seed is byte-for-byte deterministic (FR-3), so two offline devices write an
 *  identical blob at an identical path and git merges them with no conflict. */
export async function getOrCreateDaily(
  root: string,
  todayIso: string,
): Promise<{ path: string; created: boolean }> {
  const rel = dailyNoteFilename(todayIso)
  const existing = await readFile(absPathFor(root, vaultRelPath(rel)), 'utf8').catch(() => null)
  if (existing !== null) return { path: rel, created: false }
  await writeAtomic(root, vaultRelPath(rel), buildDailyNoteContent(todayIso))
  return { path: rel, created: true }
}

/**
 * On-open sweep: archive prior-day dailies into `journal/`, delete untouched
 * unreferenced stubs.
 *
 * Selects on the **`type: daily-note` frontmatter**, never the filename, so a
 * hand-authored note that merely looks like a date is never touched. Root-level
 * only, and today is skipped — `journal/` entries already have a folder prefix,
 * so a re-run is a no-op directory listing.
 */
export async function sweepDaily(
  root: string,
  todayIso: string,
): Promise<{ archived: number; deleted: number }> {
  const todayFile = dailyNoteFilename(todayIso)
  let archived = 0
  let deleted = 0
  for (const path of await listFiles(root)) {
    if (path.includes('/') || !path.endsWith('.md') || path === todayFile) continue
    const text = await readFile(`${root}/${path}`, 'utf8').catch(() => null)
    if (text === null || !isDailyNote(text)) continue
    // A root-level daily is named by its own stem, so the filename minus `.md`
    // is the stem the untouched check compares its title against.
    const untouched = isUntouchedDailyNote(text, path.slice(0, -3))
    // Backref guard: never delete a stub something links to — there is no
    // orphan-rescue net, so a wrong delete would strand a `[[link]]`.
    if (untouched && (await scanBackrefs(root, path)).length === 0) {
      await removeDocFile(root, vaultRelPath(path))
      deleted += 1
    } else {
      await renameNote(root, path, `journal/${path}`)
      archived += 1
    }
  }
  return { archived, deleted }
}
