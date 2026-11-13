/**
 * The pre-commit runner.
 *
 * The property under test everywhere here is the negative one: **a transform
 * cannot stop a commit**. Holi's auto-commit IS the user's save, so a transform
 * that throws must cost a log line, never someone's words.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanupFixtures, makeClone, makeRemote, plainGit } from './helpers/git-fixtures'
import { readHookLog } from '../src/main/vault/hooks/log'
import { runPreCommit, resetBreaker, type Transform } from '../src/main/vault/hooks/runner'
import type { StagedChanges } from '../src/main/vault/hooks/staged'

let repo: string

beforeEach(async () => {
  repo = await makeClone(await makeRemote(), 'runner')
  resetBreaker()
})

afterAll(cleanupFixtures)

const NOTHING: StagedChanges = { added: [], modified: [], renamed: [], deleted: [] }

/** A transform that reports it changed `changed`, without touching anything. */
function fake(name: string, changed: string[] = [], notes: string[] = []): Transform {
  return { name: name as Transform['name'], run: () => Promise.resolve({ changed, notes }) }
}

function throwing(name: string, message = 'boom'): Transform {
  return { name: name as Transform['name'], run: () => Promise.reject(new Error(message)) }
}

describe('which transforms run', () => {
  it('runs only the enabled ones', async () => {
    const on = vi.fn(() => Promise.resolve({ changed: [], notes: [] }))
    const off = vi.fn(() => Promise.resolve({ changed: [], notes: [] }))

    await runPreCommit(repo, NOTHING, {
      settings: { relink: true, 'archive-done': false },
      transforms: [
        { name: 'relink', run: on },
        { name: 'archive-done', run: off },
      ],
    })
    expect(on).toHaveBeenCalled()
    expect(off).not.toHaveBeenCalled()
  })

  it('treats an absent key as off', async () => {
    const never = vi.fn(() => Promise.resolve({ changed: [], notes: [] }))
    await runPreCommit(repo, NOTHING, {
      settings: {},
      transforms: [{ name: 'archive-done', run: never }],
    })
    expect(never).not.toHaveBeenCalled()
  })
})

describe('a transform never vetoes a commit', () => {
  it('catches a throw, records it, and still returns', async () => {
    const result = await runPreCommit(repo, NOTHING, {
      settings: { relink: true, 'normalize-md': true },
      transforms: [throwing('relink', 'could not read a note'), fake('normalize-md')],
    })
    expect(result.failed).toEqual([{ name: 'relink', error: 'could not read a note' }])
  })

  it('runs the transforms after the one that threw', async () => {
    const after = vi.fn(() => Promise.resolve({ changed: [], notes: [] }))
    await runPreCommit(repo, NOTHING, {
      settings: { relink: true, 'normalize-md': true },
      transforms: [throwing('relink'), { name: 'normalize-md', run: after }],
    })
    expect(after).toHaveBeenCalled()
  })

  it('puts the failure in the log where the agent can find it', async () => {
    await runPreCommit(repo, NOTHING, {
      settings: { relink: true },
      transforms: [throwing('relink', 'could not read a note')],
    })
    expect(await readHookLog(repo)).toContain('could not read a note')
  })
})

describe('restaging', () => {
  it('restages what a transform rewrote, so THIS commit carries the fix', async () => {
    // Not the next one. A commit that ships the un-rewritten file is a commit
    // with the bug in it, whatever the following one says.
    await writeFile(join(repo, 'a.md'), '# original\n', 'utf8')
    await plainGit(repo, ['add', 'a.md'])
    await writeFile(join(repo, 'a.md'), '# rewritten by a transform\n', 'utf8')

    await runPreCommit(repo, NOTHING, {
      settings: { 'normalize-md': true },
      transforms: [fake('normalize-md', ['a.md'])],
    })

    const staged = await plainGit(repo, ['diff', '--cached', '--', 'a.md'])
    expect(staged).toContain('rewritten by a transform')
    expect(await plainGit(repo, ['diff', '--', 'a.md'])).toBe('')
  })

  it('restages a deletion as happily as a write', async () => {
    // archive-done reports both ends of a move; `git add` has to see the gone
    // one too or the commit keeps the file at its old path.
    await writeFile(join(repo, 'gone.md'), '# x\n', 'utf8')
    await plainGit(repo, ['add', '-A'])
    await plainGit(repo, ['commit', '-m', 'add gone.md'])
    await rm(join(repo, 'gone.md'))

    const result = await runPreCommit(repo, NOTHING, {
      settings: { 'archive-done': true },
      transforms: [fake('archive-done', ['gone.md'])],
    })
    expect(result.failed).toEqual([])
    expect(await readHookLog(repo)).not.toContain('restage FAILED')
    expect(await plainGit(repo, ['diff', '--cached', '--name-status'])).toContain('D\tgone.md')
  })

  it('restages a transformed index without adding ignored local state', async () => {
    await mkdir(join(repo, '.holi/state/log'), { recursive: true })
    await mkdir(join(repo, '.holi/memory'), { recursive: true })
    await writeFile(join(repo, '.gitignore'), '.holi/state/log/*.local.md\n', 'utf8')
    await writeFile(join(repo, '.holi/state/log/run.local.md'), 'local state\n', 'utf8')
    await writeFile(join(repo, '.holi/memory/index.md'), 'old index\n', 'utf8')
    const trackedLocalPath = '.holi/state/log/tracked.local.md'
    await writeFile(join(repo, trackedLocalPath), 'old tracked local state\n', 'utf8')
    const spacePath = 'note with spaces.md'
    const newlinePath = 'note with\nnewline.md'
    await writeFile(join(repo, spacePath), 'old spaced note\n', 'utf8')
    await writeFile(join(repo, newlinePath), 'old newline note\n', 'utf8')
    await plainGit(repo, ['add', '.gitignore', '.holi/memory/index.md', spacePath, newlinePath])
    await plainGit(repo, ['add', '-f', trackedLocalPath])
    await writeFile(join(repo, '.holi/memory/index.md'), 'transformed index\n', 'utf8')
    await writeFile(join(repo, trackedLocalPath), 'transformed tracked local state\n', 'utf8')
    await writeFile(join(repo, spacePath), 'transformed spaced note\n', 'utf8')
    await writeFile(join(repo, newlinePath), 'transformed newline note\n', 'utf8')

    const result = await runPreCommit(repo, NOTHING, {
      settings: { 'memory-index': true },
      transforms: [
        {
          name: 'memory-index',
          run: async () => ({
            changed: [
              '.holi/memory/index.md',
              '.holi/state/log/run.local.md',
              trackedLocalPath,
              spacePath,
              newlinePath,
            ],
            notes: [],
          }),
        },
      ],
    })

    expect(result.failed).toEqual([])
    expect(await readHookLog(repo)).not.toContain('restage FAILED')
    await plainGit(repo, ['commit', '-m', 'transformed memory index'])
    expect(await plainGit(repo, ['show', 'HEAD:.holi/memory/index.md'])).toContain(
      'transformed index',
    )
    expect(await plainGit(repo, ['show', `HEAD:${trackedLocalPath}`])).toContain(
      'transformed tracked local state',
    )
    expect(await plainGit(repo, ['show', `HEAD:${spacePath}`])).toContain('transformed spaced')
    expect(await plainGit(repo, ['show', `HEAD:${newlinePath}`])).toContain('transformed newline')
    expect(await plainGit(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain(
      'run.local.md',
    )
  })

  it('restages without enumerating unrelated ignored files', async () => {
    const ignoredDir = ['ignored', ...Array<string>(3).fill('x'.repeat(170))].join('/')
    await mkdir(join(repo, ignoredDir), { recursive: true })
    await writeFile(join(repo, '.gitignore'), 'ignored/\n', 'utf8')
    // A whole-tree ignored-file listing exceeds execFile's 1 MiB output limit.
    for (let start = 0; start < 1600; start += 100) {
      await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          writeFile(join(repo, ignoredDir, `${start + index}-${'x'.repeat(200)}`), ''),
        ),
      )
    }
    await writeFile(join(repo, 'rewritten.md'), 'transformed note\n', 'utf8')

    await runPreCommit(repo, NOTHING, {
      settings: { 'normalize-md': true },
      transforms: [fake('normalize-md', ['rewritten.md'])],
    })

    expect(await readHookLog(repo)).not.toContain('restage FAILED')
    expect(await plainGit(repo, ['show', ':rewritten.md'])).toContain('transformed note')
  })

  it('does not expand glob characters in a transformed filename', async () => {
    await writeFile(join(repo, 'note[1].md'), 'transformed note\n', 'utf8')
    await writeFile(join(repo, 'note1.md'), 'unrelated note\n', 'utf8')

    await runPreCommit(repo, NOTHING, {
      settings: { 'normalize-md': true },
      transforms: [fake('normalize-md', ['note[1].md'])],
    })

    expect(await readHookLog(repo)).not.toContain('restage FAILED')
    expect(await plainGit(repo, ['diff', '--cached', '--name-only'])).toBe('note[1].md')
  })

  it('restages ordinary untracked additions', async () => {
    await writeFile(join(repo, 'new.md'), '# new note\n', 'utf8')

    await runPreCommit(repo, NOTHING, {
      settings: { 'normalize-md': true },
      transforms: [fake('normalize-md', ['new.md'])],
    })

    expect(await plainGit(repo, ['diff', '--cached', '--name-status'])).toContain('A\tnew.md')
  })

  it('restages deletions of tracked ignored files', async () => {
    await writeFile(join(repo, '.gitignore'), '*.local.md\n', 'utf8')
    await writeFile(join(repo, 'tracked.local.md'), 'tracked local content\n', 'utf8')
    await plainGit(repo, ['add', '.gitignore'])
    await plainGit(repo, ['add', '-f', 'tracked.local.md'])
    await plainGit(repo, ['commit', '-m', 'track local file'])
    await rm(join(repo, 'tracked.local.md'))

    await runPreCommit(repo, NOTHING, {
      settings: { 'archive-done': true },
      transforms: [fake('archive-done', ['tracked.local.md'])],
    })

    expect(await readHookLog(repo)).not.toContain('restage FAILED')
    expect(await plainGit(repo, ['diff', '--cached', '--name-status'])).toContain(
      'D\ttracked.local.md',
    )
  })

  it('reports genuine restage errors', async () => {
    await runPreCommit(repo, NOTHING, {
      settings: { relink: true },
      transforms: [fake('relink', ['not-a-repository-path'])],
    })

    expect(await readHookLog(repo)).toContain('restage FAILED')
  })

  it('restages nothing when nothing changed', async () => {
    const result = await runPreCommit(repo, NOTHING, {
      settings: { relink: true },
      transforms: [fake('relink')],
    })
    expect(result.changed).toEqual([])
  })
})

describe('the circuit breaker', () => {
  it('disables a transform that has failed three runs in a row', async () => {
    const run = vi.fn(() => Promise.reject(new Error('boom')))
    const opts = {
      settings: { relink: true },
      transforms: [{ name: 'relink' as const, run }],
    }
    for (let i = 0; i < 3; i += 1) await runPreCommit(repo, NOTHING, opts)
    expect(run).toHaveBeenCalledTimes(3)

    const fourth = await runPreCommit(repo, NOTHING, opts)
    expect(run).toHaveBeenCalledTimes(3) // not called again
    expect(fourth.disabled).toEqual(['relink'])
  })

  it('says so in the log rather than going quiet', async () => {
    const opts = {
      settings: { relink: true },
      transforms: [throwing('relink')],
    }
    for (let i = 0; i < 4; i += 1) await runPreCommit(repo, NOTHING, opts)
    expect(await readHookLog(repo)).toMatch(/disabled/i)
  })

  it('a success resets the count', async () => {
    const run = vi
      .fn(() => Promise.reject(new Error('boom')))
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
      .mockImplementationOnce(() => Promise.resolve({ changed: [], notes: [] }))
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
    const opts = { settings: { relink: true }, transforms: [{ name: 'relink' as const, run }] }

    for (let i = 0; i < 5; i += 1) await runPreCommit(repo, NOTHING, opts)
    expect(run).toHaveBeenCalledTimes(5) // never tripped
  })

  it('is per-transform, not global', async () => {
    const healthy = vi.fn(() => Promise.resolve({ changed: [], notes: [] }))
    const opts = {
      settings: { relink: true, 'normalize-md': true },
      transforms: [throwing('relink'), { name: 'normalize-md' as const, run: healthy }],
    }
    for (let i = 0; i < 4; i += 1) await runPreCommit(repo, NOTHING, opts)
    expect(healthy).toHaveBeenCalledTimes(4)
  })
})

describe('notifying the agent', () => {
  it('pushes the run to a listening agent', async () => {
    const notify = vi.fn()
    await runPreCommit(repo, NOTHING, {
      settings: { relink: true },
      transforms: [fake('relink', ['a.md'], ['relink: rewrote 1 file'])],
      notify,
    })
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('relink: rewrote 1 file'))
  })

  it('says nothing when there is nothing to say', async () => {
    const notify = vi.fn()
    await runPreCommit(repo, NOTHING, {
      settings: { relink: true },
      transforms: [fake('relink')],
      notify,
    })
    expect(notify).not.toHaveBeenCalled()
  })

  it('is a silent no-op when nobody is listening', async () => {
    // No agent session open is the normal case, not an error — and an error
    // here would become the failure it was reporting.
    const notify = vi.fn(() => {
      throw new Error('nobody home')
    })
    const result = await runPreCommit(repo, NOTHING, {
      settings: { relink: true },
      transforms: [fake('relink', ['a.md'], ['did a thing'])],
      notify,
    })
    expect(result.failed).toEqual([])
  })
})

describe('the log', () => {
  it('records what each transform did', async () => {
    await runPreCommit(repo, NOTHING, {
      settings: { relink: true },
      transforms: [fake('relink', ['a.md'], ['relink: rewrote links in 1 file'])],
    })
    expect(await readHookLog(repo)).toContain('relink: rewrote links in 1 file')
  })

  it('writes nothing for a run in which nothing happened', async () => {
    await runPreCommit(repo, NOTHING, {
      settings: { relink: true },
      transforms: [fake('relink')],
    })
    expect(await readHookLog(repo)).toBe('')
  })

  it('is gitignored in a seeded vault', async () => {
    await mkdir(join(repo, '.holi/state'), { recursive: true })
    await writeFile(join(repo, '.gitignore'), '*.local.*\n', 'utf8')
    await runPreCommit(repo, NOTHING, {
      settings: { relink: true },
      transforms: [fake('relink', [], ['something happened'])],
    })
    const ignored = await plainGit(repo, [
      'check-ignore',
      '-q',
      '.holi/state/hooks.local.log',
    ]).then(
      () => true,
      () => false,
    )
    expect(ignored).toBe(true)
    expect(await readFile(join(repo, '.holi/state/hooks.local.log'), 'utf8')).toContain('something')
  })
})
