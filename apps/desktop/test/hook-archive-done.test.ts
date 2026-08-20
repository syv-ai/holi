/**
 * `archive-done` — move long-finished tasks out of the way, links and all.
 *
 * Against a real repo, because the completion date comes from git: `Task` has
 * no `completedAt` field, and mtime is reset by a checkout, so the last commit
 * that touched the file is the only durable answer available.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { cleanupFixtures, makeClone, makeRemote, plainGit } from './helpers/git-fixtures'
import { archiveDone } from '../src/main/vault/hooks/archive-done'
import type { StagedChanges } from '../src/main/vault/hooks/staged'

let repo: string

beforeEach(async () => {
  repo = await makeClone(await makeRemote(), 'archive')
})

afterAll(cleanupFixtures)

const NOTHING: StagedChanges = { added: [], modified: [], renamed: [] }

/** Days after the fixture's commits, so "how long ago" is controlled without
 *  rewriting git's clock. */
function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
}

async function commitFile(rel: string, text: string): Promise<void> {
  await mkdir(join(repo, rel, '..'), { recursive: true })
  await writeFile(join(repo, rel), text, 'utf8')
  await plainGit(repo, ['add', '-A'])
  await plainGit(repo, ['commit', '-m', `write ${rel}`])
}

const task = (status: string, title = 'Fix login') =>
  `---\ntitle: ${title}\nstatus: ${status}\n---\n\nthe description\n`

const exists = async (rel: string) =>
  (await readFile(join(repo, rel), 'utf8').catch(() => null)) !== null

const read = (rel: string) => readFile(join(repo, rel), 'utf8')

describe('archive-done', () => {
  it('archives a done task older than the threshold', async () => {
    await commitFile('projects/task.fix-login.md', task('done'))

    const result = await archiveDone(repo, NOTHING, { now: daysFromNow(30) })
    expect(result.changed).toContain('archive/projects/task.fix-login.md')
    expect(await exists('archive/projects/task.fix-login.md')).toBe(true)
    expect(await exists('projects/task.fix-login.md')).toBe(false)
  })

  it('leaves a task finished today exactly where it is', async () => {
    // A task completed this morning is still what the user is looking at.
    await commitFile('projects/task.fix-login.md', task('done'))

    const result = await archiveDone(repo, NOTHING, {})
    expect(result.changed).toEqual([])
    expect(await exists('projects/task.fix-login.md')).toBe(true)
  })

  it('never moves a todo or a doing task, however old', async () => {
    await commitFile('projects/task.todo.md', task('todo'))
    await commitFile('projects/task.doing.md', task('doing'))

    const result = await archiveDone(repo, NOTHING, { now: daysFromNow(400) })
    expect(result.changed).toEqual([])
    expect(await exists('projects/task.todo.md')).toBe(true)
    expect(await exists('projects/task.doing.md')).toBe(true)
  })

  it('rewrites inbound links to a task it moved', async () => {
    // The harm sweepDaily's backref guard exists to prevent: a moved file and a
    // stranded [[link]].
    await commitFile('projects/task.fix-login.md', task('done'))
    await commitFile('notes.md', 'blocked on [[projects/task.fix-login.md]]\n')

    const result = await archiveDone(repo, NOTHING, { now: daysFromNow(30) })
    expect(await read('notes.md')).toBe('blocked on [[archive/projects/task.fix-login.md]]\n')
    // And the rewritten file must be in `changed`, or the runner never restages
    // it and the fix lands in the NEXT commit while this one ships a dangling link.
    expect(result.changed).toContain('notes.md')
  })

  it('keeps a link label across the archive move', async () => {
    await commitFile('projects/task.fix-login.md', task('done'))
    await commitFile('notes.md', 'see [[projects/task.fix-login.md|the login fix]]\n')

    await archiveDone(repo, NOTHING, { now: daysFromNow(30) })
    expect(await read('notes.md')).toBe('see [[archive/projects/task.fix-login.md|the login fix]]\n')
  })

  it('moves nothing the second time', async () => {
    await commitFile('projects/task.fix-login.md', task('done'))
    await archiveDone(repo, NOTHING, { now: daysFromNow(30) })
    await plainGit(repo, ['add', '-A'])
    await plainGit(repo, ['commit', '-m', 'archived'])

    const second = await archiveDone(repo, NOTHING, { now: daysFromNow(60) })
    expect(second.changed).toEqual([])
    expect(await exists('archive/archive/projects/task.fix-login.md')).toBe(false)
  })

  it('never re-archives something already under archive/', async () => {
    await commitFile('archive/old/task.ancient.md', task('done'))
    const result = await archiveDone(repo, NOTHING, { now: daysFromNow(999) })
    expect(result.changed).toEqual([])
    expect(await exists('archive/old/task.ancient.md')).toBe(true)
  })

  it('ignores a note that is not a task file', async () => {
    await commitFile('notes/done-thoughts.md', task('done'))
    const result = await archiveDone(repo, NOTHING, { now: daysFromNow(400) })
    expect(result.changed).toEqual([])
    expect(await exists('notes/done-thoughts.md')).toBe(true)
  })

  it('leaves an unparseable task file alone rather than guessing', async () => {
    // parseTaskFile decides done-ness. A file it refuses is not a task this
    // transform gets to have an opinion about.
    await commitFile('projects/task.broken.md', '---\nstatus: finished\n---\n\nbody\n')
    const result = await archiveDone(repo, NOTHING, { now: daysFromNow(400) })
    expect(result.changed).toEqual([])
    expect(await exists('projects/task.broken.md')).toBe(true)
  })

  it('leaves an uncommitted task alone — git has no date for it yet', async () => {
    await mkdir(join(repo, 'projects'), { recursive: true })
    await writeFile(join(repo, 'projects/task.brand-new.md'), task('done'), 'utf8')

    const result = await archiveDone(repo, NOTHING, { now: daysFromNow(400) })
    expect(result.changed).toEqual([])
    expect(await exists('projects/task.brand-new.md')).toBe(true)
  })

  it('says in its notes which clock it used', async () => {
    await commitFile('projects/task.fix-login.md', task('done'))
    const result = await archiveDone(repo, NOTHING, { now: daysFromNow(30) })
    expect(result.notes.join(' ')).toMatch(/last commit/i)
  })
})
