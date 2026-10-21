/**
 * Where a turn ended, for a turn that cannot have a settle commit yet.
 *
 * A session whose turn ends while another session is still mid-turn leaves a
 * paused vault: no commit may land beside a live agent. Its record must not
 * wait for the other turn, though, or its next prompt is told about its own
 * uncommitted edits as "not by you". So it ends at the working tree as it
 * stands: a tree object written through a scratch index, the same thing a
 * commit would hold, without touching `.git/index` or adding to history.
 *
 * A tree, not a commit: `git diff`, `git show <tree>:<path>` and the turn chip's
 * range all take one. Unreachable, so `git gc` prunes it after its grace
 * period, and a turn record already outlives the shas it names.
 *
 * No Electron import: this loads under plain Node like the rest of the plugin.
 */
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from '../../../../main/plugin-api'

/** HEAD when the working tree matches it, else a tree object of the working
 *  tree (ignored files left out). Null when git fails. */
export async function worktreeEnd(root: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-turn-'))
  const index = join(dir, 'index')
  try {
    const real = await runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    // Starting from a copy of the real index means only files whose stat
    // changed are hashed again. None yet (an unborn branch) starts empty.
    await copyFile(real, index).catch(() => {})
    const env = { GIT_INDEX_FILE: index }
    await runGit(root, ['add', '--all'], { env })
    const tree = await runGit(root, ['write-tree'], { env })
    const head = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')
    if (head !== '') {
      const headTree = await runGit(root, ['rev-parse', `${head}^{tree}`])
      // A clean tree ends at HEAD, so a turn that changed nothing still reads
      // as `base === end`.
      if (headTree === tree) return head
    }
    return tree
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
