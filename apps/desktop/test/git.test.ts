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
import { GitError, GitMissingError, ensureAskpass, runGit } from '../src/main/git'

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
