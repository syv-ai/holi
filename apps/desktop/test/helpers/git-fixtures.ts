/**
 * Real git repositories, for tests that need one.
 *
 * Extracted from `git.test.ts` when `vault-clone.test.ts` came to want the same
 * fixtures. They cannot simply be imported from the other test file: Vitest
 * collects tests per module, so importing `git.test.ts` would register its whole
 * suite — ~28 seconds of real git — a second time under the importer.
 *
 * Nothing here mocks anything. A bare repo in a tmpdir is a real remote to a
 * real git: fetch, merge, push and conflict behave exactly as they will against
 * GitHub, with no network and no credentials.
 */
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll } from 'vitest'

const exec = promisify(execFile)

const dirs: string[] = []
// Keep the seed across per-test cleanup; every caller gets an independent copy.
let remoteTemplate: Promise<string> | undefined
let remoteTemplateDir: string | undefined

/** Call from each consuming file's `afterAll`. */
export async function cleanupFixtures(): Promise<void> {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {})
  dirs.length = 0
}

afterAll(async () => {
  if (remoteTemplateDir) {
    await rm(remoteTemplateDir, { recursive: true, force: true }).catch(() => {})
  }
  remoteTemplateDir = undefined
  remoteTemplate = undefined
})

export async function tmp(prefix: string): Promise<string> {
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
  '-c',
  'tag.gpgSign=false',
]

export async function plainGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', [...WHO, ...args], { cwd })
  return stdout.trim()
}

/**
 * A bare repo seeded with one commit on `main`, as a path usable as a remote.
 *
 * Seeded rather than left empty on purpose: a truly empty bare repo has no
 * default branch, and every test past this one wants `origin/HEAD` to resolve.
 */
async function makeRemoteTemplate(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'holi-git-remote-template-'))
  remoteTemplateDir = base
  const bare = join(base, 'origin.git')
  await exec('git', ['init', '--bare', '-b', 'main', bare])

  const seed = join(base, 'seed')
  await exec('git', ['clone', bare, seed])
  await writeFile(join(seed, 'README.md'), '# Vault\n', 'utf8')
  // The `.holi/vault` marker, so these origins read as real Holi vaults —
  // `vaults.add` refuses to adopt (and seed) anything without it. Kept in the
  // one seed commit so commit-count and log assertions are unaffected.
  await mkdir(join(seed, '.holi'), { recursive: true })
  await writeFile(join(seed, '.holi', 'vault'), '1\n', 'utf8')
  await plainGit(seed, ['add', '-A'])
  await plainGit(seed, ['commit', '-m', 'seed'])
  await plainGit(seed, ['push', 'origin', 'main'])
  return bare
}

export async function makeRemote(): Promise<string> {
  remoteTemplate ??= makeRemoteTemplate()
  const template = await remoteTemplate
  const base = await tmp('holi-git-remote-')
  const bare = join(base, 'origin.git')
  await cp(template, bare, { recursive: true })
  return bare
}

/** A newly created remote with no commits or remote-tracking branch yet. */
export async function makeEmptyRemote(): Promise<string> {
  const base = await tmp('holi-git-empty-')
  const bare = join(base, 'origin.git')
  await exec('git', ['init', '--bare', '-b', 'main', bare])
  return bare
}

/** A bare remote that is NOT a Holi vault — a plain code repo, for the tests
 * that assert `vaults.add` refuses to adopt one. */
export async function makeNonVaultRemote(): Promise<string> {
  const base = await tmp('holi-git-plain-')
  const bare = join(base, 'origin.git')
  await exec('git', ['init', '--bare', '-b', 'main', bare])

  const seed = join(base, 'seed')
  await exec('git', ['clone', bare, seed])
  await writeFile(join(seed, 'README.md'), '# Just code\n', 'utf8')
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
  await mkdir(join(repo, rel, '..'), { recursive: true })
  await writeFile(join(repo, rel), text, 'utf8')
  await plainGit(repo, ['add', '-A'])
  await plainGit(repo, ['commit', '-m', `write ${rel}`])
}
