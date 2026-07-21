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
import { isTaskFilePath, parseTaskFile, TaskFileError, type DocMeta, type Task } from '@holi/shared'
import { isIgnoredPath, listFiles } from './vault-files'

export interface BrokenTask {
  path: string
  error: string
}

export interface VaultSnapshot {
  docs: DocMeta[]
  tasks: Task[]
  /** Task files that failed to parse. Rendered as error cards — never hidden. */
  broken: BrokenTask[]
}

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
  const snapshot: VaultSnapshot = { docs: [], tasks: [], broken: [] }

  const files = (await listFiles(root)).filter((rel) => rel.endsWith('.md') && !isIgnoredPath(rel))

  for (const path of files) {
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

    const updatedAt = await stat(`${root}/${path}`)
      .then((s) => s.mtime.toISOString())
      .catch(() => new Date(0).toISOString())

    snapshot.docs.push({ path, kind: isDaily(text) ? 'daily' : 'note', updatedAt })
  }

  return snapshot
}
