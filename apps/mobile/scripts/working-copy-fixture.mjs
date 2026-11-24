import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const exec = promisify(execFile)
const git = async (root, ...args) => (await exec('git', ['-C', root, ...args])).stdout.trim()

/** Create an offline, disposable attached working tree with a logical vault identity. */
export async function createWorkingCopyFixture(parent, runId) {
  const root = join(parent, `holi-working-copy-${runId}`)
  await mkdir(root, { recursive: true })
  await git(root, 'init', '-b', 'fixture-start')
  await git(root, 'config', 'user.name', 'Holi fixture')
  await git(root, 'config', 'user.email', 'fixture@invalid')
  await git(root, 'remote', 'add', 'origin', 'https://github.com/fixture/vault.git')
  await writeFile(join(root, 'tracked.md'), 'base\n')
  await git(root, 'add', 'tracked.md')
  await git(root, 'commit', '-m', 'fixture base')
  const cases = [
    ['staged', async () => { await writeFile(join(root, 'tracked.md'), 'staged\n'); await git(root, 'add', 'tracked.md') }],
    ['unstaged', async () => { await writeFile(join(root, 'tracked.md'), 'worktree\n') }],
    ['addition', async () => { await writeFile(join(root, 'added.md'), 'added\n') }],
    ['deletion', async () => { await git(root, 'rm', 'tracked.md') }],
  ]
  const run = async () => {
    const results = []
    for (const [name, prepare] of cases) {
      await git(root, 'reset', '--hard', 'HEAD')
      await git(root, 'clean', '-fd')
      await prepare()
      results.push({ name, changes: await git(root, 'status', '--porcelain=v2', '-z', '--untracked-files=all') })
    }
    await git(root, 'reset', '--hard', 'HEAD')
    return { root, remote: 'fixture/vault', branch: 'fixture-start', results }
  }
  return run()
}
