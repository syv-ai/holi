/**
 * What git says is about to be committed.
 *
 * **Rename detection is why the transforms live at the commit boundary.**
 * `git diff --cached -M` gives the `from → to` map; to the watcher a move is an
 * unpaired delete plus add.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface StagedChanges {
  added: string[]
  modified: string[]
  /** Paired by git's own similarity detection, not by us. */
  renamed: { from: string; to: string }[]
  /** Paths this commit removes. Only `memory-index` reads it. */
  deleted: string[]
}

/**
 * Read the staged set of `root`.
 *
 * `-z` is not optional: a vault has paths with spaces and non-ASCII in them
 * (`nøter/æøå.md`), and without it git quotes and backslash-escapes those, so
 * every transform downstream is handed a path that does not exist. With `-z`
 * the records are NUL-separated and verbatim, and a rename spends **three**
 * fields rather than two.
 */
export async function stagedChanges(root: string): Promise<StagedChanges> {
  const { stdout } = await exec(
    'git',
    ['diff', '--cached', '--name-status', '-M', '-z', '--no-color'],
    { cwd: root, maxBuffer: 32 * 1024 * 1024 },
  )

  const changes: StagedChanges = { added: [], modified: [], renamed: [], deleted: [] }
  const fields = stdout.split('\0')

  for (let i = 0; i < fields.length; i += 1) {
    const status = fields[i]
    if (status === undefined || status === '') continue

    // **Match the letter, never the whole field.** A rename is `R087`: the
    // digits are a similarity score.
    const kind = status[0]
    if (kind === 'R' || kind === 'C') {
      const from = fields[i + 1]
      const to = fields[i + 2]
      i += 2
      if (from !== undefined && to !== undefined) changes.renamed.push({ from, to })
      continue
    }

    const path = fields[i + 1]
    i += 1
    if (path === undefined) continue
    if (kind === 'A') changes.added.push(path)
    else if (kind === 'M') changes.modified.push(path)
    else if (kind === 'D') changes.deleted.push(path)
    // T (typechange), U (unmerged) and X (unknown) stay dropped: an unmerged
    // path belongs to the conflict flow rather than to a transform.
  }
  return changes
}
