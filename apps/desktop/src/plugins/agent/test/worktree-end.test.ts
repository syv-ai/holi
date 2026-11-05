/**
 * Where a turn ends while the vault is paused: the working tree, written as a
 * tree object without touching the real index.
 */
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGit } from '../../../main/plugin-api'
import { worktreeEnd } from '../main/host/worktree-end'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-worktree-end-'))
  await runGit(root, ['init', '-q'])
  await writeFile(join(root, 'note.md'), 'one\n')
  await runGit(root, ['add', '.'])
  await runGit(root, [
    '-c',
    'user.name=Ada Holm',
    '-c',
    'user.email=ada@syv.ai',
    'commit',
    '-qm',
    'init',
  ])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('worktreeEnd', () => {
  it('is HEAD when nothing changed', async () => {
    expect(await worktreeEnd(root)).toBe(await runGit(root, ['rev-parse', 'HEAD']))
  })

  it('holds edits and new files, and leaves the real index alone', async () => {
    await writeFile(join(root, 'note.md'), 'two\n')
    await writeFile(join(root, 'new.md'), 'new\n')
    const end = await worktreeEnd(root)
    expect(end).not.toBeNull()
    expect(await runGit(root, ['show', `${end}:note.md`])).toBe('two')
    const changed = await runGit(root, ['diff', '--name-only', `HEAD..${end}`])
    expect(changed.split('\n').sort()).toEqual(['new.md', 'note.md'])
    // Nothing staged, and the new file still untracked.
    expect(await runGit(root, ['diff', '--cached', '--name-only'])).toBe('')
    expect(await runGit(root, ['ls-files', '--others', '--exclude-standard'])).toBe('new.md')
  })

  it('retains same-size edits when copied-index timestamps would hide them', async () => {
    await runGit(root, ['config', 'core.trustctime', 'false'])
    const note = join(root, 'note.md')
    const fixedMtime = new Date(Math.floor(Date.now() / 1000) * 1000 + 10)
    await utimes(note, fixedMtime, fixedMtime)
    await runGit(root, ['add', 'note.md'])
    const indexedFile = await stat(note)
    const index = join(root, '.git/index')
    const indexStat = await stat(index)
    const noteMtimeMs = indexedFile.mtimeMs

    // Make the file's cached timestamp later than the index timestamp. The
    // edit then preserves that cached timestamp, triggering Git's racy check
    // on the real index but not on a freshly copied index.
    await utimes(index, indexStat.atime, noteMtimeMs - 1000)
    await writeFile(note, 'two\n')
    await utimes(note, indexedFile.atime, noteMtimeMs)

    const realIndex = await readFile(index)
    const realIndexMtime = (await stat(index)).mtimeMs
    const end = await worktreeEnd(root)
    expect(await runGit(root, ['show', `${end}:note.md`])).toBe('two')
    expect(await readFile(index)).toEqual(realIndex)
    expect((await stat(index)).mtimeMs).toBe(realIndexMtime)

    // A second snapshot still sees the same bytes; the first did not refresh
    // the real index's stale stat cache.
    const second = await worktreeEnd(root)
    expect(await runGit(root, ['show', `${second}:note.md`])).toBe('two')
  })

  it('keeps racy protection when the original index mtime has fractions', async () => {
    await runGit(root, ['config', 'core.trustctime', 'false'])
    const note = join(root, 'note.md')
    const fixedMtime = new Date(Math.floor(Date.now() / 1000) * 1000 + 10)
    await utimes(note, fixedMtime, fixedMtime)
    await runGit(root, ['add', 'note.md'])
    const indexedFile = await stat(note)
    const index = join(root, '.git/index')
    const indexStat = await stat(index)
    const noteMtimeMs = indexedFile.mtimeMs
    // The fractional source time rounds up in stat.mtimeMs. Restoring a copy
    // with that rounded value would put its time after the file's timestamp.
    await utimes(index, indexStat.atime, noteMtimeMs - 1000.25)
    expect((await stat(index, { bigint: true })).mtimeNs % 1_000_000n).not.toBe(0n)
    await writeFile(note, 'two\n')
    await utimes(note, indexedFile.atime, noteMtimeMs)

    const end = await worktreeEnd(root)
    expect(await runGit(root, ['show', `${end}:note.md`])).toBe('two')
  })

  it('includes staged changes and deletions but excludes ignored files', async () => {
    await writeFile(join(root, '.gitignore'), 'ignored.md\n')
    await runGit(root, ['add', '.gitignore'])
    await writeFile(join(root, 'note.md'), 'staged\n')
    await runGit(root, ['add', 'note.md'])
    await rm(join(root, 'note.md'))
    await writeFile(join(root, 'ignored.md'), 'ignored\n')

    const end = await worktreeEnd(root)
    if (end === null) throw new Error('expected a worktree tree')
    expect(await runGit(root, ['ls-tree', '-r', '--name-only', end])).toBe('.gitignore')
    expect(await runGit(root, ['diff', '--cached', '--name-only'])).toBe('.gitignore\nnote.md')
  })

  it('supports an unborn repository', async () => {
    const unborn = await mkdtemp(join(tmpdir(), 'holi-worktree-unborn-'))
    try {
      await runGit(unborn, ['init', '-q'])
      await writeFile(join(unborn, 'note.md'), 'unborn\n')
      const end = await worktreeEnd(unborn)
      expect(end).not.toBeNull()
      expect(await runGit(unborn, ['show', `${end}:note.md`])).toBe('unborn')
      expect(await runGit(unborn, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).toBe('')
    } finally {
      await rm(unborn, { recursive: true, force: true })
    }
  })

  it('is null outside a repository', async () => {
    expect(await worktreeEnd(join(root, 'missing'))).toBeNull()
  })
})
