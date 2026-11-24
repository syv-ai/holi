import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  lstat,
  readlink,
  writeFile,
  symlink,
  rm,
} from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { stagingDirectory, legacyStagingDirectory } from '../app/storage-staging.ts'

const exec = promisify(execFile)
const remoteUrl = 'https://github.com/fixture/vault.git'
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
)
Object.assign(env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Holi fixture',
  GIT_AUTHOR_EMAIL: 'fixture@invalid',
  GIT_COMMITTER_NAME: 'Holi fixture',
  GIT_COMMITTER_EMAIL: 'fixture@invalid',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'commit.gpgsign',
  GIT_CONFIG_VALUE_1: 'false',
})
const git = async (root, ...args) => (await exec('git', ['-C', root, ...args], { env })).stdout
const put = async (root, path, content, mode) => {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, mode ? { mode } : undefined)
}

async function tree(root) {
  const entries = []
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name),
        info = await lstat(path),
        rel = relative(root, path)
      if (info.isDirectory()) await walk(path)
      else
        entries.push(
          info.isSymbolicLink()
            ? { path: rel, symlink: await readlink(path) }
            : {
                path: rel,
                mode: info.mode & 0o777,
                bytes: await readFile(path)
                  .then((b) => b.toString('base64'))
                  .catch((error) => {
                    if (error.code === 'EACCES') return 'unreadable'
                    throw error
                  }),
              },
        )
    }
  }
  await walk(root)
  return entries
}
async function snapshotWorkingCopy(root) {
  return tree(root)
}
export async function verifyWorkingCopyUnchanged(root, snapshot) {
  return JSON.stringify(await snapshotWorkingCopy(root)) === JSON.stringify(snapshot)
}

const exclusions = (path) =>
  path === '.git' ||
  path.startsWith('.git/') ||
  path === '.holi/memory/index.md' ||
  path.startsWith('.holi/memory/') ||
  path
    .split('/')
    .some(
      (part) =>
        part === '.env' ||
        part.startsWith('.env.') ||
        part.includes('.local.') ||
        part === '.secrets' ||
        part.startsWith('.secrets.'),
    )
function semanticEntries(raw) {
  const records = raw.split('\0').filter(Boolean),
    out = []
  for (const row of records) {
    const fields = row.split(' ')
    if (row.startsWith('1 ')) {
      const p = fields.slice(row.startsWith('u ') ? 10 : 8).join(' ')
      if (!exclusions(p))
        out.push({ kind: 'change', path: p, index: fields[1][0], worktree: fields[1][1] })
    } else if (row.startsWith('2 ')) {
      const p = fields.slice(row.startsWith('u ') ? 10 : 8).join(' '),
        original = records[records.indexOf(row) + 1]
      if (!exclusions(p) && !exclusions(original))
        out.push({ kind: 'rename', path: p, original, index: fields[1][0], worktree: fields[1][1] })
    } else if (row.startsWith('u ')) {
      const p = fields.slice(row.startsWith('u ') ? 10 : 8).join(' ')
      if (!exclusions(p)) out.push({ kind: 'conflict', path: p })
    } else if (row.startsWith('? ')) {
      const p = row.slice(2)
      if (!exclusions(p)) out.push({ kind: 'untracked', path: p })
    }
  }
  return out.filter((entry) => entry.path !== 'outside.md')
}

export async function createWorkingCopyFixture(parent, runId, libraryRoot) {
  const cases = []
  const specs = [
    ['clean', async () => {}],
    [
      'unicode-case',
      async (r) => {
        await git(r, 'config', 'core.ignorecase', 'true')
        await put(r, 'Ä.md', 'unicode')
        await git(r, 'add', 'Ä.md')
        await git(r, 'commit', '-m', 'unicode fixture')
        const fs = await import('node:fs/promises')
        await fs.rename(join(r, 'Ä.md'), join(r, 'unicode-temp'))
        await fs.rename(join(r, 'unicode-temp'), join(r, 'ä.md'))
      },
    ],
    [
      'local-case-alias',
      async (r) => {
        await git(r, 'config', 'core.ignorecase', 'true')
        await put(r, 'note.local.md', 'protected')
        await git(r, 'add', 'note.local.md')
        await git(r, 'commit', '-m', 'private alias fixture')
        const fs = await import('node:fs/promises')
        await fs.rename(join(r, 'note.local.md'), join(r, 'local-temp'))
        await fs.rename(join(r, 'local-temp'), join(r, 'NOTE.LOCAL.MD'))
        await chmod(join(r, 'NOTE.LOCAL.MD'), 0)
      },
    ],
    ['mixed-alternates', async (r) => put(r, '.git/objects/info/ALTERNATES', parent + '\n')],
    [
      'case-alias',
      async (r) => {
        await git(r, 'config', 'core.ignorecase', 'true')
        const fs = await import('node:fs/promises')
        await fs.rename(join(r, 'tracked.md'), join(r, 'case-temp'))
        await fs.rename(join(r, 'case-temp'), join(r, 'TRACKED.md'))
      },
    ],
    ['attributes', async (r) => put(r, '.gitattributes', '*.md text\n')],
    [
      'tracked-spaces',
      async (r) => {
        await put(r, 'tracked space.md', 'staged\n')
        await git(r, 'add', 'tracked space.md')
        await put(r, 'tracked space.md', 'worktree\n')
      },
    ],
    [
      'ignored-deletion',
      async (r) => {
        await git(r, 'rm', '--cached', 'tracked.md')
        await put(r, '.gitignore', 'tracked.md\n')
        await chmod(join(r, 'tracked.md'), 0)
      },
    ],
    [
      'same-line-config',
      async (r) =>
        put(
          r,
          '.git/config',
          (await readFile(join(r, '.git/config'), 'utf8')) +
            '\n[core] [include]\n path = /outside/config\n',
        ),
    ],
    ['outside-symlink', async (r) => symlink(parent, join(r, 'outside.md'))],
    ['branch-name', async (r) => git(r, 'checkout', '-b', 'attributes')],
    ['pending-save', async () => {}],
    ['pending-move', async () => {}],
    ['pending-legacy', async () => {}],
    [
      'staged',
      async (r) => {
        await put(r, 'tracked.md', 'staged\n')
        await git(r, 'add', 'tracked.md')
      },
    ],
    ['unstaged', async (r) => put(r, 'tracked.md', 'worktree\n')],
    [
      'combined',
      async (r) => {
        await put(r, 'tracked.md', 'combined\n')
        await git(r, 'add', 'tracked.md')
        await put(r, 'tracked.md', 'unstaged\n')
      },
    ],
    ['addition', async (r) => put(r, 'added.md', 'added\n')],
    [
      'autocrlf',
      async (r) => {
        await git(r, 'config', 'core.autocrlf', 'true')
      },
    ],
    [
      'skip-worktree',
      async (r) => {
        await git(r, 'update-index', '--skip-worktree', 'tracked.md')
        await put(r, 'tracked.md', 'hidden worktree change\n')
      },
    ],
    [
      'ignored-untracked',
      async (r) => {
        await put(r, '.gitignore', 'ignored.md\n')
        await put(r, 'ignored.md', 'ignored\n')
      },
    ],
    ['deletion', async (r) => git(r, 'rm', 'tracked.md')],
    [
      'file-directory',
      async (r) => {
        await git(r, 'rm', 'tracked.md')
        await put(r, 'tracked.md/child.md', 'child\n')
      },
    ],
    [
      'staged-binary-mode',
      async (r) => {
        await put(r, 'image.bin', Buffer.from([0, 255, 1]))
        await git(r, 'add', 'image.bin')
        await chmod(join(r, 'tracked.md'), 0o755)
        await git(r, 'add', 'tracked.md')
      },
    ],
    [
      'worktree-deletion',
      async (r) => {
        await import('node:fs/promises').then((fs) => fs.unlink(join(r, 'tracked.md')))
      },
    ],
    [
      'conflict',
      async (r) => {
        await git(r, 'checkout', '-b', 'other')
        await put(r, 'tracked.md', 'other\n')
        await git(r, 'commit', '-am', 'other')
        await git(r, 'checkout', 'fixture-start')
        await put(r, 'tracked.md', 'local\n')
        await git(r, 'commit', '-am', 'local')
        await git(r, 'merge', 'other').catch(() => {})
      },
    ],
    [
      'protected-name',
      async (r) => {
        for (const [p, b] of [
          ['.env', 'secret'],
          ['notes.local.md', 'private'],
          ['image.bin', 'non-note'],
        ]) {
          await put(r, p, b)
          if (p !== 'image.bin') await chmod(join(r, p), 0)
        }
      },
    ],
    ['spaced-name', async (r) => put(r, 'notes with spaces.md', 'spaced\n')],
    ['detached', async (r) => git(r, 'checkout', '--detach', 'HEAD')],
    ['unborn', async (r) => git(r, 'checkout', '--orphan', 'unborn')],
    [
      'identity',
      async (r) => git(r, 'remote', 'set-url', 'origin', 'https://github.com/elsewhere/other.git'),
    ],
    [
      'unsafe-config',
      async (r) => git(r, 'config', 'core.worktree', '/tmp/holi-external-worktree'),
    ],
    [
      'metadata',
      async (r) => {
        await rm(join(r, '.git'), { recursive: true })
        await symlink(parent, join(r, '.git'))
      },
    ],
  ]
  for (const [name, mutate] of specs) {
    if (name.startsWith('pending-') && !libraryRoot) continue
    const root = await mkdtemp(join(parent, `holi-${runId}-${name}-`))
    await git(root, 'init', '-b', 'fixture-start')
    await git(root, 'config', 'user.name', 'Holi fixture')
    await git(root, 'config', 'user.email', 'fixture@invalid')
    await git(root, 'remote', 'add', 'origin', remoteUrl)
    await put(root, 'tracked.md', 'base\n')
    await put(root, 'tracked space.md', 'base\n')
    await git(root, 'add', 'tracked.md', 'tracked space.md')
    await git(root, 'commit', '-m', 'fixture base')
    await mutate(root)
    const expectedRefusal = [
      'detached',
      'unborn',
      'identity',
      'unsafe-config',
      'metadata',
      'same-line-config',
      'mixed-alternates',
      'autocrlf',
      'attributes',
      'skip-worktree',
      'pending-save',
      'pending-move',
      'pending-legacy',
    ].includes(name)
    const expectedChanges = expectedRefusal
      ? null
      : semanticEntries(
          await git(
            root,
            'status',
            '--porcelain=v2',
            '-z',
            '--untracked-files=all',
            '--no-renames',
          ),
        )
    const recovery = []
    if (libraryRoot && name.startsWith('pending-')) {
      const directory =
        name === 'pending-legacy'
          ? legacyStagingDirectory(libraryRoot, root)
          : stagingDirectory(libraryRoot, root)
      await mkdir(directory, { recursive: true })
      const filename =
        name === 'pending-move'
          ? 'move-00000000-0000-0000-0000-000000000003.json'
          : 'stage-00000000-0000-0000-0000-000000000001.tmp'
      const path = join(directory, filename)
      await writeFile(path, 'pending fixture')
      recovery.push({ path, bytes: Buffer.from('pending fixture').toString('base64') })
    }
    cases.push({
      name,
      root,
      remote: 'fixture/vault',
      branch: name === 'detached' ? null : name === 'branch-name' ? 'attributes' : 'fixture-start',
      expectedChanges,
      expectedRefusal,
      refusalPattern: name.startsWith('pending-')
        ? 'Vault recovery is pending'
        : name === 'identity' || name === 'detached'
          ? 'identity does not match'
          : name === 'metadata' || name === 'mixed-alternates'
            ? 'Git metadata|metadata indirection'
            : name === 'unborn'
              ? 'unborn|not found|reference'
              : name === 'skip-worktree'
                ? 'Unsupported index'
                : name === 'attributes'
                  ? 'Attributes are unsupported'
                  : name === 'autocrlf'
                    ? 'normalization'
                    : 'config|directives',
      recovery,
      before: await snapshotWorkingCopy(root),
    })
  }
  return { cases }
}
