/**
 * Where a turn ends while the vault is paused: the working tree, written as a
 * tree object without touching the real index.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

  it('is null outside a repository', async () => {
    expect(await worktreeEnd(join(root, 'missing'))).toBeNull()
  })
})
