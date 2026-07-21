/**
 * The git engine, tested against real repositories.
 *
 * Nothing here mocks `execFile`, deliberately. The whole reason Holi shells out
 * to the system binary is that git's *refusal* to merge is load-bearing — FR-12
 * and the entire reconcile path rest on it — so a mock would test this file's
 * idea of git rather than git.
 *
 * Every test builds a bare repo in a tmpdir and clones it. That is a real remote
 * to a real git: fetch, merge, push and conflict all behave exactly as they will
 * against GitHub, with no network and no credentials. A second clone of the same
 * bare repo plays the teammate.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { GitError, GitMissingError, ensureAskpass, openRepo, runGit, tryGit } from '../src/main/git'

const exec = promisify(execFile)

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {})
})

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Identity flags, so these tests pass on a machine that has never run
 * `git config --global user.email`. */
const WHO = [
  '-c',
  'user.name=Holi Test',
  '-c',
  'user.email=test@holi.invalid',
  '-c',
  'commit.gpgsign=false',
]

async function plainGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', [...WHO, ...args], { cwd })
  return stdout.trim()
}

/**
 * A bare repo seeded with one commit on `main`, as a path usable as a remote.
 *
 * Seeded rather than left empty on purpose: a truly empty bare repo has no
 * default branch, and every test past this one wants `origin/HEAD` to resolve.
 */
export async function makeRemote(): Promise<string> {
  const base = await tmp('holi-git-remote-')
  const bare = join(base, 'origin.git')
  await exec('git', ['init', '--bare', '-b', 'main', bare])

  const seed = join(base, 'seed')
  await exec('git', ['clone', bare, seed])
  await writeFile(join(seed, 'README.md'), '# Vault\n', 'utf8')
  await plainGit(seed, ['add', '-A'])
  await plainGit(seed, ['commit', '-m', 'seed'])
  await plainGit(seed, ['push', 'origin', 'main'])
  return bare
}

/** A working clone of `remote`, with a local identity configured. */
export async function makeClone(remote: string, name = 'clone'): Promise<string> {
  const base = await tmp(`holi-git-${name}-`)
  const dir = join(base, name)
  await exec('git', ['clone', remote, dir])
  await plainGit(dir, ['config', 'user.name', 'Holi Test'])
  await plainGit(dir, ['config', 'user.email', 'test@holi.invalid'])
  return dir
}

/** Write a file and commit it, as a teammate on another machine would. */
export async function commitFile(repo: string, rel: string, text: string): Promise<void> {
  await writeFile(join(repo, rel), text, 'utf8')
  await plainGit(repo, ['add', '-A'])
  await plainGit(repo, ['commit', '-m', `write ${rel}`])
}

describe('status', () => {
  it('reports a fresh clone as clean, in step, on the default branch', async () => {
    const repo = openRepo(await makeClone(await makeRemote()))
    expect(await repo.status()).toEqual({
      branch: 'main',
      defaultBranch: 'main',
      ahead: 0,
      behind: 0,
      dirty: false,
      merging: false,
      detached: false,
      unborn: false,
    })
  })

  it('reports an edited file as dirty', async () => {
    const dir = await makeClone(await makeRemote())
    await writeFile(join(dir, 'README.md'), '# Changed\n', 'utf8')
    expect((await openRepo(dir).status()).dirty).toBe(true)
  })

  it('reports an untracked file as dirty — a new note must reach the commit', async () => {
    const dir = await makeClone(await makeRemote())
    await writeFile(join(dir, 'new-note.md'), 'hi\n', 'utf8')
    expect((await openRepo(dir).status()).dirty).toBe(true)
  })

  it('counts commits waiting to publish', async () => {
    const dir = await makeClone(await makeRemote())
    await commitFile(dir, 'a.md', 'a\n')
    await commitFile(dir, 'b.md', 'b\n')
    const status = await openRepo(dir).status()
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(0)
  })

  it('counts commits waiting to arrive', async () => {
    const remote = await makeRemote()
    const dir = await makeClone(remote)
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(teammate, 'theirs.md', 'theirs\n')
    await plainGit(teammate, ['push', 'origin', 'main'])

    await runGit(dir, ['fetch', 'origin'])
    expect((await openRepo(dir).status()).behind).toBe(1)
  })

  it('survives a repo with no commits at all', async () => {
    // "New vault" creates an empty GitHub repo and walks straight into this.
    const base = await tmp('holi-git-unborn-')
    const dir = join(base, 'fresh')
    await exec('git', ['init', '-b', 'main', dir])
    const status = await openRepo(dir).status()
    expect(status.unborn).toBe(true)
    expect(status.branch).toBe('main')
  })

  it('reports a detached HEAD, which FR-2 refuses to sync', async () => {
    const dir = await makeClone(await makeRemote())
    await plainGit(dir, ['checkout', '--detach', 'HEAD'])
    expect((await openRepo(dir).status()).detached).toBe(true)
  })

  it('reports a merge in progress', async () => {
    const remote = await makeRemote()
    const dir = await makeClone(remote)
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(teammate, 'README.md', '# Theirs\n')
    await plainGit(teammate, ['push', 'origin', 'main'])
    await commitFile(dir, 'README.md', '# Ours\n')
    await runGit(dir, ['fetch', 'origin'])
    // Left mid-merge on purpose — this is the state a reconcile runs inside.
    await tryGit(dir, ['merge', '--no-edit', 'origin/main'])

    expect((await openRepo(dir).status()).merging).toBe(true)
  })
})

describe('commitAll', () => {
  it('commits a burst of changes as ONE commit', async () => {
    // FR-5: a board drag across three lanes, or an agent turn touching ten
    // files, is one commit — not three, and not ten.
    const dir = await makeClone(await makeRemote())
    const before = await plainGit(dir, ['rev-list', '--count', 'HEAD'])
    for (const name of ['a.md', 'b.md', 'c.md']) {
      await writeFile(join(dir, name), `${name}\n`, 'utf8')
    }

    const sha = await openRepo(dir).commitAll('Update 3 files')
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(Number(await plainGit(dir, ['rev-list', '--count', 'HEAD']))).toBe(Number(before) + 1)
  })

  it('leaves the tree clean, which is what lets a pull always merge', async () => {
    // FR-7. This is the invariant the whole auto-pull design rests on.
    const dir = await makeClone(await makeRemote())
    await writeFile(join(dir, 'a.md'), 'a\n', 'utf8')
    const repo = openRepo(dir)
    await repo.commitAll('Update a.md')
    expect((await repo.status()).dirty).toBe(false)
  })

  it('returns null when there is nothing to commit', async () => {
    // The idle timer fires on untouched vaults constantly. This is the normal
    // path, not an error.
    const repo = openRepo(await makeClone(await makeRemote()))
    expect(await repo.commitAll('Update nothing')).toBeNull()
  })

  it('commits a deletion, not just a change', async () => {
    const dir = await makeClone(await makeRemote())
    await rm(join(dir, 'README.md'))
    expect(await openRepo(dir).commitAll('Delete README.md')).not.toBeNull()
    expect((await openRepo(dir).status()).dirty).toBe(false)
  })

  it('commits on a machine that has never configured a git identity', async () => {
    // A fresh laptop has no user.email, and git refuses to commit without one.
    // Holi must not require the user to have run `git config --global` first.
    const remote = await makeRemote()
    const base = await tmp('holi-git-noident-')
    const dir = join(base, 'clone')
    await exec('git', ['clone', remote, dir])
    await writeFile(join(dir, 'a.md'), 'a\n', 'utf8')

    const repo = openRepo(dir, {
      identity: { name: 'Holi', email: 'holi@localhost' },
      // An empty HOME hides any global config, so this is a real fresh machine.
      env: { HOME: base, USERPROFILE: base, GIT_CONFIG_GLOBAL: join(base, 'nonexistent') },
    })
    expect(await repo.commitAll('Update a.md')).not.toBeNull()
  })
})

describe('runGit', () => {
  it('runs a command in the given repo and returns its stdout', async () => {
    const repo = await makeClone(await makeRemote())
    expect(await runGit(repo, ['rev-parse', '--is-inside-work-tree'])).toBe('true')
  })

  it('throws GitError carrying the exit code and stderr', async () => {
    const repo = await makeClone(await makeRemote())
    // A sha that does not exist: git exits non-zero and explains itself on stderr.
    const err = await runGit(repo, ['cat-file', '-p', 'deadbeef']).catch((e) => e)
    expect(err).toBeInstanceOf(GitError)
    expect(err.code).toBeGreaterThan(0)
    expect(err.stderr).not.toBe('')
  })

  it('reports a missing binary as GitMissingError, not as a failed command', async () => {
    // Every user is assumed to be a developer, so git is assumed present — but
    // the failure when it is not must be advice, not a stack trace.
    const repo = await makeClone(await makeRemote())
    const err = await runGit(repo, ['status'], { gitPath: 'definitely-not-git' }).catch((e) => e)
    expect(err).toBeInstanceOf(GitMissingError)
  })

  it('answers git’s credential prompt from the environment, never from argv', async () => {
    // The token must not reach a command line: argv is readable by other
    // processes, and a token baked into a remote URL outlives the session in
    // .git/config. So git asks, and this script answers from the environment.
    const script = await ensureAskpass()
    const answer = (prompt: string) =>
      exec(script, [prompt], { env: { ...process.env, HOLI_GIT_TOKEN: 'ghp_secret' } }).then((r) =>
        r.stdout.trim(),
      )

    expect(await answer("Password for 'https://github.com'")).toBe('ghp_secret')
    // GitHub takes the token as the password with any username, so this is a constant.
    expect(await answer("Username for 'https://github.com'")).toBe('x-access-token')
  })

  it('never lets git block on a credential prompt', async () => {
    // Without GIT_TERMINAL_PROMPT=0 an auth failure hangs forever on a prompt
    // nobody can answer, which turns a test failure into a stuck suite.
    const repo = await makeClone(await makeRemote())
    const err = await runGit(repo, ['ls-remote', 'https://127.0.0.1:1/nope.git']).catch((e) => e)
    expect(err).toBeInstanceOf(GitError)
  }, 20_000)
})
