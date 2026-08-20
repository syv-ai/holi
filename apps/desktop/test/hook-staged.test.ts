/**
 * What git says is about to be committed.
 *
 * Against a real repo rather than a mock, because the whole reason this module
 * exists is git's **rename detection** — the `from → to` map that Holi's own
 * watcher cannot produce, since to a watcher a move is a delete plus an add.
 * A mock would be asserting my own understanding of `--name-status -M` back at
 * me, which is exactly the thing worth testing.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { cleanupFixtures, makeClone, makeRemote, plainGit } from './helpers/git-fixtures'
import { stagedChanges } from '../src/main/vault/hooks/staged'

let repo: string

beforeEach(async () => {
  repo = await makeClone(await makeRemote(), 'staged')
})

afterAll(cleanupFixtures)

/** Write and `git add`, without committing. */
async function stage(rel: string, text: string): Promise<void> {
  await mkdir(join(repo, rel, '..'), { recursive: true })
  await writeFile(join(repo, rel), text, 'utf8')
  await plainGit(repo, ['add', rel])
}

/** Get a file into HEAD so the next change is a modification or a rename. */
async function commit(rel: string, text: string): Promise<void> {
  await stage(rel, text)
  await plainGit(repo, ['commit', '-m', `add ${rel}`])
}

describe('stagedChanges', () => {
  it('sees a staged add', async () => {
    await stage('notes/new.md', '# new\n')
    expect(await stagedChanges(repo)).toEqual({
      added: ['notes/new.md'],
      modified: [],
      renamed: [],
    })
  })

  it('sees a staged edit', async () => {
    await commit('a.md', '# a\n')
    await stage('a.md', '# a, edited\n')
    expect(await stagedChanges(repo)).toEqual({ added: [], modified: ['a.md'], renamed: [] })
  })

  it('sees a rename as ONE renamed entry, not an add plus a delete', async () => {
    // The entire reason these transforms live at the commit boundary.
    await commit('a.md', '# a\n')
    await plainGit(repo, ['mv', 'a.md', 'b.md'])
    expect(await stagedChanges(repo)).toEqual({
      added: [],
      modified: [],
      renamed: [{ from: 'a.md', to: 'b.md' }],
    })
  })

  it('sees a rename into a subdirectory', async () => {
    await commit('a.md', '# a\n')
    await mkdir(join(repo, 'sub'), { recursive: true })
    await plainGit(repo, ['mv', 'a.md', 'sub/b.md'])
    expect((await stagedChanges(repo)).renamed).toEqual([{ from: 'a.md', to: 'sub/b.md' }])
  })

  it('still calls a rename-with-edits a rename', async () => {
    // git reports `R087`, not `R100`. Matching the letter rather than the score
    // is the difference between seeing this and seeing an add plus a delete.
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    await commit('a.md', `${body}\n`)
    await plainGit(repo, ['mv', 'a.md', 'b.md'])
    await writeFile(join(repo, 'b.md'), `${body}\nand one more line\n`, 'utf8')
    await plainGit(repo, ['add', 'b.md'])

    const staged = await stagedChanges(repo)
    expect(staged.renamed).toEqual([{ from: 'a.md', to: 'b.md' }])
    expect(staged.added).toEqual([])
  })

  it('ignores an unstaged change', async () => {
    await commit('a.md', '# a\n')
    await writeFile(join(repo, 'a.md'), '# not added\n', 'utf8')
    await writeFile(join(repo, 'untracked.md'), '# nor this\n', 'utf8')
    expect(await stagedChanges(repo)).toEqual({ added: [], modified: [], renamed: [] })
  })

  it('survives a path with spaces and non-ASCII', async () => {
    // `-z`, or git quotes and escapes these and every transform gets a path
    // that does not exist.
    await stage('nøter/æøå note.md', '# hej\n')
    expect((await stagedChanges(repo)).added).toEqual(['nøter/æøå note.md'])
  })

  it('renames a path with spaces without mangling either end', async () => {
    await commit('gamle nøter/æøå.md', '# hej\n')
    await mkdir(join(repo, 'nye nøter'), { recursive: true })
    await plainGit(repo, ['mv', 'gamle nøter/æøå.md', 'nye nøter/æøå.md'])
    expect((await stagedChanges(repo)).renamed).toEqual([
      { from: 'gamle nøter/æøå.md', to: 'nye nøter/æøå.md' },
    ])
  })

  it('includes a binary file — the transforms filter, this does not', async () => {
    await mkdir(join(repo, 'assets'), { recursive: true })
    await writeFile(join(repo, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
    await plainGit(repo, ['add', 'assets/logo.png'])
    expect((await stagedChanges(repo)).added).toEqual(['assets/logo.png'])
  })

  it('sees a deletion as none of the three', async () => {
    // Nothing to rewrite in a file that is going away; `relink` reads renames.
    await commit('a.md', '# a\n')
    await rm(join(repo, 'a.md'))
    await plainGit(repo, ['add', '-A'])
    expect(await stagedChanges(repo)).toEqual({ added: [], modified: [], renamed: [] })
  })

  it('reports nothing in a clean repo', async () => {
    expect(await stagedChanges(repo)).toEqual({ added: [], modified: [], renamed: [] })
  })
})
