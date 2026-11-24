import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, mkdir, readFile, readdir, lstat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

const exec = promisify(execFile)
const remoteUrl = 'https://github.com/fixture/vault.git'
const isolatedEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Holi fixture',
  GIT_AUTHOR_EMAIL: 'fixture@invalid',
  GIT_COMMITTER_NAME: 'Holi fixture',
  GIT_COMMITTER_EMAIL: 'fixture@invalid',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
}
const git = async (root, ...args) => (await exec('git', ['-C', root, ...args], { env: isolatedEnv })).stdout.trim()
const put = async (root, path, content, mode) => {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, mode ? { mode } : undefined)
}

async function tree(root) {
  const entries = []
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name)
      const info = await lstat(path)
      if (info.isDirectory()) await walk(path)
      else entries.push({ path: relative(root, path), mode: info.mode & 0o777, bytes: (await readFile(path)).toString('base64') })
    }
  }
  await walk(root)
  return entries
}

/** Snapshot files, index, refs, config and object database for non-mutation checks. */
export async function snapshotWorkingCopy(root) {
  const files = await tree(root)
  return files.filter(({ path }) => !path.includes('/tmp/'))
}

export async function verifyWorkingCopyUnchanged(root, snapshot) {
  const current = await snapshotWorkingCopy(root)
  return JSON.stringify(current) === JSON.stringify(snapshot)
}

/** Create independent, persistent offline repositories; callers own their cleanup. */
export async function createWorkingCopyFixture(parent, runId) {
  const cases = []
  const specs = [
    ['clean', async () => {}],
    ['staged', async r => { await put(r, 'tracked.md', 'staged\n'); await git(r, 'add', 'tracked.md') }],
    ['unstaged', async r => put(r, 'tracked.md', 'worktree\n')],
    ['combined', async r => { await put(r, 'tracked.md', 'combined\n'); await git(r, 'add', 'tracked.md'); await put(r, 'tracked.md', 'unstaged\n') }],
    ['addition', async r => put(r, 'added.md', 'added\n')],
    ['deletion', async r => git(r, 'rm', 'tracked.md')],
    ['binary', async r => put(r, 'image.bin', Buffer.from([0, 255, 1]))],
    ['mode', async r => chmod(join(r, 'tracked.md'), 0o755)],
    ['conflict', async r => { await git(r, 'checkout', '-b', 'other'); await put(r, 'tracked.md', 'other\n'); await git(r, 'commit', '-am', 'other'); await git(r, 'checkout', 'fixture-start'); await put(r, 'tracked.md', 'local\n'); await git(r, 'commit', '-am', 'local'); await git(r, 'merge', 'other').catch(() => {}) }],
    ['protected-name', async r => put(r, '.git/config', '[malicious]\n')],
    ['detached', async r => git(r, 'checkout', '--detach', 'HEAD')],
    ['unborn', async r => git(r, 'checkout', '--orphan', 'unborn')],
    ['identity', async r => git(r, 'remote', 'set-url', 'origin', 'https://github.com/elsewhere/other.git')],
    ['unsafe-config', async r => git(r, 'config', 'core.autocrlf', 'true')],
    ['metadata', async r => put(r, '.holi/settings/app.yaml', 'bad: true\n')],
  ]
  for (const [name, mutate] of specs) {
    const root = await mkdtemp(join(parent, `holi-${runId}-${name}-`))
    await git(root, 'init', '-b', 'fixture-start')
    await git(root, 'config', 'user.name', 'Holi fixture')
    await git(root, 'config', 'user.email', 'fixture@invalid')
    await git(root, 'remote', 'add', 'origin', remoteUrl)
    await put(root, 'tracked.md', 'base\n')
    await git(root, 'add', 'tracked.md')
    await git(root, 'commit', '-m', 'fixture base')
    await mutate(root)
    const changes = await git(root, 'status', '--porcelain=v2', '-z', '--untracked-files=all')
    cases.push({ name, root, remote: 'fixture/vault', branch: name === 'detached' ? null : 'fixture-start', expectedChanges: changes, expectedRefusal: ['protected-name', 'detached', 'unborn', 'identity', 'unsafe-config', 'metadata'].includes(name) })
  }
  return { cases }
}
