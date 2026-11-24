import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, mkdir, readFile, readdir, lstat, readlink, writeFile, symlink } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

const exec = promisify(execFile)
const remoteUrl = 'https://github.com/fixture/vault.git'
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Holi fixture', GIT_AUTHOR_EMAIL: 'fixture@invalid', GIT_COMMITTER_NAME: 'Holi fixture', GIT_COMMITTER_EMAIL: 'fixture@invalid', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'commit.gpgsign', GIT_CONFIG_VALUE_1: 'false' })
const git = async (root, ...args) => (await exec('git', ['-C', root, ...args], { env })).stdout
const put = async (root, path, content, mode) => { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, mode ? { mode } : undefined) }

async function tree(root) {
  const entries = []
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), info = await lstat(path), rel = relative(root, path)
      if (info.isDirectory()) await walk(path)
      else entries.push(info.isSymbolicLink() ? { path: rel, symlink: await readlink(path) } : { path: rel, mode: info.mode & 0o777, bytes: (await readFile(path)).toString('base64') })
    }
  }
  await walk(root); return entries
}
export async function snapshotWorkingCopy(root) { return tree(root) }
export async function verifyWorkingCopyUnchanged(root, snapshot) { return JSON.stringify(await snapshotWorkingCopy(root)) === JSON.stringify(snapshot) }

const exclusions = path => path === '.git' || path.startsWith('.git/') || path === '.holi/memory/index.md' || path.startsWith('.holi/memory/') || path.split('/').some(part => part === '.env' || part.startsWith('.env.') || part.includes('.local.') || part === '.secrets' || part.startsWith('.secrets.'))
function semanticEntries(raw) {
  const records = raw.split('\0').filter(Boolean), out = []
  for (const row of records) {
    const fields = row.split(' ')
    if (row.startsWith('1 ')) { const p = fields.at(-1); if (!exclusions(p)) out.push({ kind: 'change', path: p, index: fields[1][0], worktree: fields[1][1] }) }
    else if (row.startsWith('2 ')) { const p = fields.at(-1), original = records[records.indexOf(row) + 1]; if (!exclusions(p) && !exclusions(original)) out.push({ kind: 'rename', path: p, original, index: fields[1][0], worktree: fields[1][1] }) }
    else if (row.startsWith('u ')) { const p = fields.at(-1); if (!exclusions(p)) out.push({ kind: 'conflict', path: p }) }
    else if (row.startsWith('? ')) { const p = row.slice(2); if (!exclusions(p)) out.push({ kind: 'untracked', path: p }) }
  }
  return out
}

export async function createWorkingCopyFixture(parent, runId, libraryRoot) {
  const cases = []
  const specs = [
    ['clean', async () => {}], ['staged', async r => { await put(r, 'tracked.md', 'staged\n'); await git(r, 'add', 'tracked.md') }],
    ['unstaged', async r => put(r, 'tracked.md', 'worktree\n')], ['combined', async r => { await put(r, 'tracked.md', 'combined\n'); await git(r, 'add', 'tracked.md'); await put(r, 'tracked.md', 'unstaged\n') }],
    ['addition', async r => put(r, 'added.md', 'added\n')], ['deletion', async r => git(r, 'rm', 'tracked.md')],
    ['file-directory', async r => { await git(r, 'rm', 'tracked.md'); await put(r, 'tracked.md/child.md', 'child\n') }],
    ['staged-binary-mode', async r => { await put(r, 'image.bin', Buffer.from([0, 255, 1])); await git(r, 'add', 'image.bin'); await chmod(join(r, 'tracked.md'), 0o755); await git(r, 'add', 'tracked.md') }],
    ['worktree-deletion', async r => { await import('node:fs/promises').then(fs => fs.unlink(join(r, 'tracked.md'))) }],
    ['conflict', async r => { await git(r, 'checkout', '-b', 'other'); await put(r, 'tracked.md', 'other\n'); await git(r, 'commit', '-am', 'other'); await git(r, 'checkout', 'fixture-start'); await put(r, 'tracked.md', 'local\n'); await git(r, 'commit', '-am', 'local'); await git(r, 'merge', 'other').catch(() => {}) }],
    ['protected-name', async r => { for (const [p, b] of [['.env', 'secret'], ['notes.local.md', 'private'], ['image.bin', 'non-note']]) { await put(r, p, b); await chmod(join(r,p), 0) } }],
    ['detached', async r => git(r, 'checkout', '--detach', 'HEAD')], ['unborn', async r => git(r, 'checkout', '--orphan', 'unborn')],
    ['identity', async r => git(r, 'remote', 'set-url', 'origin', 'https://github.com/elsewhere/other.git')],
    ['unsafe-config', async r => git(r, 'config', 'core.worktree', '/tmp/holi-external-worktree')],
    ['metadata', async r => { await import('node:fs/promises').then(fs => fs.unlink(join(r,'.git'))); await symlink(parent, join(r,'.git')) }],
  ]
  for (const [name, mutate] of specs) {
    const root = await mkdtemp(join(parent, `holi-${runId}-${name}-`))
    await git(root, 'init', '-b', 'fixture-start'); await git(root, 'config', 'user.name', 'Holi fixture'); await git(root, 'config', 'user.email', 'fixture@invalid'); await git(root, 'remote', 'add', 'origin', remoteUrl)
    await put(root, 'tracked.md', 'base\n'); await git(root, 'add', 'tracked.md'); await git(root, 'commit', '-m', 'fixture base'); await mutate(root)
    const expectedRefusal = ['protected-name', 'detached', 'unborn', 'identity', 'unsafe-config', 'metadata'].includes(name)
    const expectedChanges = expectedRefusal ? null : semanticEntries(await git(root, 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames'))
    const recovery = []
    if (libraryRoot) { /* Storage journals use move-<id>.json; callers supply real pending files. */
      for (const entry of await readdir(libraryRoot, { withFileTypes: true }).catch(() => [])) if (entry.isFile() && /^move-[A-Za-z0-9_-]+\.json$/.test(entry.name)) recovery.push({ name: entry.name, bytes: (await readFile(join(libraryRoot, entry.name))).toString('base64') })
    }
    cases.push({ name, root, remote: 'fixture/vault', branch: name === 'detached' ? null : 'fixture-start', expectedChanges, expectedRefusal, recovery })
  }
  return { cases }
}
