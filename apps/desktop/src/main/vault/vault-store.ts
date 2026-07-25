/**
 * The vault store: the filesystem, read as a vault.
 *
 * This replaces the VaultMirror, and it is a fraction of it. The mirror existed
 * to keep a CRDT store and a working copy in step; there is one representation
 * now, so a "scan" is a directory walk and a parse, and the watcher's job is
 * only to say *when* to do it again.
 *
 * Two rules the tests pin, both of which cost data if broken:
 *
 *   - A task is a task because of its **filename** (`task.*.md`), and a daily
 *     note is a daily because of its **frontmatter** (`type: daily-note`).
 *     Never the other way round: a filename that merely looks like a date is
 *     often a note a human wrote, and the archive sweep deletes empty dailies.
 *   - A task file that does not parse is **reported, not dropped**. Silently
 *     omitting it from the board is indistinguishable from data loss, and the
 *     model will occasionally write bad frontmatter.
 */
import { readFile, stat } from 'node:fs/promises'
import { isTaskFilePath, parseTaskFile, TaskFileError, type VaultSnapshot } from '@holi/shared'
import { isIgnoredPath, listFiles } from './vault-files'

// The shape is `@holi/shared`'s: the renderer reads it too, and a type that
// crossed the IPC seam by being imported out of `main/` would make the seam a
// lie. Re-exported so the scan and its result still read as one module.
export type { BrokenTask, VaultSnapshot } from '@holi/shared'

/**
 * `type: daily-note` in the file's **leading** frontmatter block, and nowhere
 * else. Scanning the whole text would let a note containing a horizontal rule
 * and the words `type: daily-note` be classified as a system-created daily —
 * and the archive sweep deletes empty dailies, so a false positive here is how
 * you lose someone's note.
 */
function isDaily(text: string): boolean {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return false
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return false
  return /^type:[ \t]*daily-note[ \t]*$/m.test(normalized.slice(4, end + 1))
}

/** Everything the vault holds, read fresh off disk. */
export async function scanVault(root: string): Promise<VaultSnapshot> {
  const snapshot: VaultSnapshot = { docs: [], tasks: [], broken: [], files: [] }

  const all = (await listFiles(root)).filter((rel) => !isIgnoredPath(rel))

  for (const path of all) {
    const mtime = () =>
      stat(`${root}/${path}`)
        .then((s) => s.mtime.toISOString())
        .catch(() => new Date(0).toISOString())

    // Non-markdown: a plain file entry. No read, no parse — it is not a note, so
    // it stays out of `docs` and the link-aware ops (backrefs/rename) never see
    // it (spec §Arbitrary files).
    if (!path.endsWith('.md')) {
      snapshot.files.push({ path, updatedAt: await mtime() })
      continue
    }

    const text = await readFile(`${root}/${path}`, 'utf8').catch(() => null)
    // A file that vanished between the walk and the read is not an error: the
    // watcher is about to tell us about it anyway.
    if (text === null) continue

    if (isTaskFilePath(path)) {
      try {
        snapshot.tasks.push(parseTaskFile(text, path))
      } catch (err) {
        if (!(err instanceof TaskFileError)) throw err
        snapshot.broken.push({ path, error: err.message })
      }
      continue
    }

    snapshot.docs.push({ path, kind: isDaily(text) ? 'daily' : 'note', updatedAt: await mtime() })
  }

  return snapshot
}
