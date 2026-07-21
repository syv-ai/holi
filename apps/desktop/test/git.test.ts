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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import {
  GitError,
  GitMissingError,
  classifyPushFailure,
  ensureAskpass,
  openRepo,
  runGit,
  tryGit,
} from '../src/main/git'

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

describe('pull', () => {
  /** Us and a teammate, both cloned from the same remote. */
  async function pair() {
    const remote = await makeRemote()
    return { ours: await makeClone(remote), theirs: await makeClone(remote, 'teammate') }
  }

  async function publish(repo: string, rel: string, text: string) {
    await commitFile(repo, rel, text)
    await plainGit(repo, ['push', 'origin', 'main'])
  }

  it('is up-to-date when the remote has not moved', async () => {
    const { ours } = await pair()
    expect(await openRepo(ours).pull()).toEqual({ kind: 'up-to-date' })
  })

  it('brings a teammate’s work in without anyone remembering anything', async () => {
    const { ours, theirs } = await pair()
    await publish(theirs, 'theirs.md', 'their note\n')

    expect(await openRepo(ours).pull()).toEqual({ kind: 'merged', commits: 1 })
    expect(await readFile(join(ours, 'theirs.md'), 'utf8')).toBe('their note\n')
  })

  it('merges when both sides changed different files', async () => {
    const { ours, theirs } = await pair()
    await publish(theirs, 'theirs.md', 'theirs\n')
    await commitFile(ours, 'ours.md', 'ours\n')

    expect((await openRepo(ours).pull()).kind).toBe('merged')
    expect(await readFile(join(ours, 'theirs.md'), 'utf8')).toBe('theirs\n')
    expect(await readFile(join(ours, 'ours.md'), 'utf8')).toBe('ours\n')
  })

  /** A task's frontmatter, with one field swapped. */
  const taskFile = (over: Partial<Record<string, string>> = {}) => {
    const f = { title: 'A', status: 'todo', due: '2026-08-01', tags: '[x]', priority: 'low', ...over }
    return `---\ntitle: ${f.title}\nstatus: ${f.status}\ndue: ${f.due}\ntags: ${f.tags}\npriority: ${f.priority}\n---\n`
  }

  it('merges two edits to the same file when the changed lines are apart', async () => {
    // prd/tasks.md §Concurrency: two people editing different fields of one
    // task both survive. True — with the caveat pinned by the next test.
    const { ours, theirs } = await pair()
    await publish(theirs, 'task.a.md', taskFile())
    await openRepo(ours).pull()

    await publish(theirs, 'task.a.md', taskFile({ priority: 'high' })) // line 6
    await commitFile(ours, 'task.a.md', taskFile({ due: '2026-09-09' })) // line 4

    expect((await openRepo(ours).pull()).kind).toBe('merged')
    const merged = await readFile(join(ours, 'task.a.md'), 'utf8')
    expect(merged).toContain('priority: high') // theirs
    expect(merged).toContain('due: 2026-09-09') // ours
  })

  it('CONFLICTS when the two changed lines are adjacent, even though the fields differ', async () => {
    // Not a bug — git's merge needs at least one unchanged line between two
    // changes to treat them as independent hunks. Adjacent edits overlap.
    //
    // This narrows a promise in prd/tasks.md §Concurrency ("two people editing
    // different fields of the same task ... both survive"): it holds only when
    // the fields are not neighbours, and in a five-line frontmatter block
    // neighbours are the common case. `status` and `due` are adjacent in the
    // PRD's own example format, and are the two fields most likely to be edited
    // by two people at once.
    const { ours, theirs } = await pair()
    await publish(theirs, 'task.a.md', taskFile())
    await openRepo(ours).pull()

    await publish(theirs, 'task.a.md', taskFile({ status: 'doing' })) // line 3
    await commitFile(ours, 'task.a.md', taskFile({ due: '2026-09-09' })) // line 4

    expect(await openRepo(ours).pull()).toEqual({ kind: 'conflict', paths: ['task.a.md'] })
  })

  it('reports a conflict AND leaves the tree clean', async () => {
    // FR-12, and the most important assertion in this file. A conflicted tree
    // contains <<<<<<< markers, and autosave would happily commit them — so the
    // abort must have already run by the time this returns. Ignore the banner
    // and you keep working on an unbroken vault.
    const { ours, theirs } = await pair()
    await publish(theirs, 'README.md', '# Theirs\n')
    await commitFile(ours, 'README.md', '# Ours\n')

    const repo = openRepo(ours)
    expect(await repo.pull()).toEqual({ kind: 'conflict', paths: ['README.md'] })

    const after = await repo.status()
    expect(after.dirty).toBe(false)
    expect(after.merging).toBe(false)
    expect(await readFile(join(ours, 'README.md'), 'utf8')).toBe('# Ours\n')
  })

  it('merges rather than rebases, so local commits keep their identity', async () => {
    // FR-10. A rebase would replay our commit onto theirs and give it a new
    // sha — and with dozens of autosave commits it would conflict repeatedly on
    // the same hunk. Merge resolves the divergence once.
    const { ours, theirs } = await pair()
    await publish(theirs, 'theirs.md', 'theirs\n')
    await commitFile(ours, 'ours.md', 'ours\n')
    const before = await plainGit(ours, ['rev-parse', 'HEAD'])

    await openRepo(ours).pull()

    // Our commit still exists, unrewritten, and is now an ancestor of HEAD.
    expect(await plainGit(ours, ['cat-file', '-t', before])).toBe('commit')
    expect(await plainGit(ours, ['merge-base', '--is-ancestor', before, 'HEAD'])).toBe('')
  })
})

describe('push', () => {
  it('sends local commits to the default branch', async () => {
    const remote = await makeRemote()
    const dir = await makeClone(remote)
    await commitFile(dir, 'ours.md', 'ours\n')

    expect(await openRepo(dir).push()).toEqual({ kind: 'pushed', commits: 1 })
    // The remote really moved: a fresh clone sees the file.
    const check = await makeClone(remote, 'check')
    expect(await readFile(join(check, 'ours.md'), 'utf8')).toBe('ours\n')
  })

  it('reports nothing to push when already in step', async () => {
    const dir = await makeClone(await makeRemote())
    expect(await openRepo(dir).push()).toEqual({ kind: 'nothing-to-push' })
  })

  it('distinguishes a non-fast-forward rejection', async () => {
    // FR-14 hands this to the pull that was going to happen anyway, so it must
    // be told apart from a permission failure rather than lumped in with it.
    const remote = await makeRemote()
    const dir = await makeClone(remote)
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(teammate, 'theirs.md', 'theirs\n')
    await plainGit(teammate, ['push', 'origin', 'main'])
    await commitFile(dir, 'ours.md', 'ours\n')

    expect(await openRepo(dir).push()).toEqual({ kind: 'rejected', reason: 'non-fast-forward' })
  })

  it.skipIf(process.platform === 'win32')(
    'fails honestly against an unwritable remote rather than guessing why',
    async () => {
      // A read-only local bare repo fails at the object-write layer ("unpacker
      // error"), which is NOT an auth failure — so it must not be reported as
      // one. Claiming "you lack permission" when the remote's disk is full is
      // exactly the misreporting FR-16 exists to prevent.
      const remote = await makeRemote()
      const dir = await makeClone(remote)
      await commitFile(dir, 'ours.md', 'ours\n')
      await exec('chmod', ['-R', 'a-w', remote])
      try {
        await expect(openRepo(dir).push()).rejects.toThrow(GitError)
      } finally {
        await exec('chmod', ['-R', 'u+w', remote]) // or afterAll cannot clean up
      }
    },
  )
})

describe('classifyPushFailure', () => {
  // The rejection reason cannot be provoked locally — a real permission failure
  // needs a real remote refusing a real token — so the classifier is pinned
  // against verbatim output instead. These strings are what git and GitHub
  // actually emit; the integration tests above cover the paths that CAN be
  // reproduced.

  it('reads GitHub’s permission refusal as permission (auth FR-13)', () => {
    expect(
      classifyPushFailure(
        '',
        'remote: Permission to syv-ai/1brain.git denied to someone.\n' +
          "fatal: unable to access 'https://github.com/syv-ai/1brain.git/': The requested URL returned error: 403\n",
      ),
    ).toBe('permission')
  })

  it('reads a revoked or expired token as permission, not as a network failure', () => {
    expect(
      classifyPushFailure('', "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/syv-ai/1brain.git/'\n"),
    ).toBe('permission')
  })

  it('reads a stale ref as non-fast-forward', () => {
    expect(
      classifyPushFailure(
        'To github.com:syv-ai/1brain.git\n!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)\nDone\n',
        'error: failed to push some refs\n',
      ),
    ).toBe('non-fast-forward')
  })

  it('refuses to classify anything else — an unknown failure is not a permission failure', () => {
    // The whole point: silence beats a confident wrong answer, because the
    // caller renders this reason to the user verbatim.
    expect(
      classifyPushFailure(
        'To /tmp/o.git\n!\tHEAD:refs/heads/main\t[remote rejected] (unpacker error)\n',
        'error: remote unpack failed: unable to create temporary object directory\n',
      ),
    ).toBeNull()
    expect(classifyPushFailure('', 'fatal: unable to access: Could not resolve host: github.com\n')).toBeNull()
  })
})

describe('publish', () => {
  it('pulls before pushing, so a moved remote is not an error', async () => {
    // FR-14. Without the pull-first rule this is the non-fast-forward rejection
    // from the test above — and there is nothing for a user to do about it that
    // the app could not do itself.
    const remote = await makeRemote()
    const dir = await makeClone(remote)
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(teammate, 'theirs.md', 'theirs\n')
    await plainGit(teammate, ['push', 'origin', 'main'])
    await commitFile(dir, 'ours.md', 'ours\n')

    expect((await openRepo(dir).publish()).kind).toBe('pushed')
    const check = await makeClone(remote, 'check')
    expect(await readFile(join(check, 'ours.md'), 'utf8')).toBe('ours\n')
    expect(await readFile(join(check, 'theirs.md'), 'utf8')).toBe('theirs\n')
  })

  it('stops at a conflicting pull and pushes nothing', async () => {
    // FR-15: the user's work stays local and intact, and the remote is untouched.
    const remote = await makeRemote()
    const dir = await makeClone(remote)
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(teammate, 'README.md', '# Theirs\n')
    await plainGit(teammate, ['push', 'origin', 'main'])
    await commitFile(dir, 'README.md', '# Ours\n')

    const repo = openRepo(dir)
    expect(await repo.publish()).toEqual({ kind: 'conflict', paths: ['README.md'] })
    expect((await repo.status()).dirty).toBe(false)

    const check = await makeClone(remote, 'check')
    expect(await readFile(join(check, 'README.md'), 'utf8')).toBe('# Theirs\n')
  })
})

describe('log', () => {
  it('returns commits newest first, with sha, subject, date and author', async () => {
    const dir = await makeClone(await makeRemote())
    await commitFile(dir, 'a.md', 'a\n')

    const [head, ...rest] = await openRepo(dir).log()
    expect(head!.subject).toBe('write a.md')
    expect(head!.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(head!.author).toBe('Holi Test')
    expect(head!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(rest[0]!.subject).toBe('seed')
  })

  it('follows a file through a rename', async () => {
    // The history PRD promises the open file's timeline survives a rename, and
    // a rename is how a note moves lanes.
    const dir = await makeClone(await makeRemote())
    await commitFile(dir, 'old.md', 'content\n')
    await plainGit(dir, ['mv', 'old.md', 'new.md'])
    await plainGit(dir, ['commit', '-m', 'rename old.md to new.md'])

    const history = await openRepo(dir).log({ path: 'new.md' })
    expect(history.map((c) => c.subject)).toEqual(['rename old.md to new.md', 'write old.md'])
  })

  it('respects the limit', async () => {
    const dir = await makeClone(await makeRemote())
    await commitFile(dir, 'a.md', 'a\n')
    await commitFile(dir, 'b.md', 'b\n')
    expect(await openRepo(dir).log({ limit: 1 })).toHaveLength(1)
  })

  it('handles a subject containing the separator it is delimited with', async () => {
    // A commit subject is user text and can contain anything. Splitting on a
    // character a human can type would corrupt the parse.
    const dir = await makeClone(await makeRemote())
    await writeFile(join(dir, 'a.md'), 'a\n', 'utf8')
    await plainGit(dir, ['add', '-A'])
    await plainGit(dir, ['commit', '-m', 'Update a.md\twith\ttabs and | pipes'])

    expect((await openRepo(dir).log({ limit: 1 }))[0]!.subject).toBe(
      'Update a.md\twith\ttabs and | pipes',
    )
  })

  it('returns an empty list for a repo with no commits, rather than throwing', async () => {
    const base = await tmp('holi-git-nolog-')
    const dir = join(base, 'fresh')
    await exec('git', ['init', '-b', 'main', dir])
    expect(await openRepo(dir).log()).toEqual([])
  })
})

describe('abortMerge', () => {
  it('restores a clean tree from mid-merge', async () => {
    const remote = await makeRemote()
    const dir = await makeClone(remote)
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(teammate, 'README.md', '# Theirs\n')
    await plainGit(teammate, ['push', 'origin', 'main'])
    await commitFile(dir, 'README.md', '# Ours\n')
    await runGit(dir, ['fetch', 'origin'])
    await tryGit(dir, ['merge', '--no-edit', 'origin/main'])

    const repo = openRepo(dir)
    expect((await repo.status()).merging).toBe(true)
    await repo.abortMerge()

    const after = await repo.status()
    expect(after.merging).toBe(false)
    expect(after.dirty).toBe(false)
    // FR-20: the pre-merge state is a commit, so nothing was ever at risk.
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('# Ours\n')
  })

  it('is a no-op when no merge is in progress', async () => {
    // The control can be pressed twice without turning into an error.
    const repo = openRepo(await makeClone(await makeRemote()))
    await expect(repo.abortMerge()).resolves.toBeUndefined()
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
