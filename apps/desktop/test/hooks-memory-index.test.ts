/**
 * `memory-index` — the index lands in the commit that changed the memory (D89).
 *
 * Against a real repo because the transform reads the working tree, and because
 * the two claims worth guarding are both about *not* doing work: it must cost
 * nothing on a commit that touches no memory, and it must not report a change
 * when the index it would write is the one already there.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { MEMORY_INDEX } from '@holi/shared'
import { cleanupFixtures, makeClone, makeRemote, plainGit } from './helpers/git-fixtures'
import { memoryIndex } from '../src/main/vault/hooks/memory-index'
import { runPreCommit, resetBreaker } from '../src/main/vault/hooks/runner'
import type { StagedChanges } from '../src/main/vault/hooks/staged'

let repo: string

beforeEach(async () => {
  repo = await makeClone(await makeRemote(), 'memory')
  resetBreaker()
})

afterAll(cleanupFixtures)

const NOTHING: StagedChanges = { added: [], modified: [], renamed: [], deleted: [] }
const added = (...paths: string[]): StagedChanges => ({ ...NOTHING, added: paths })

const memory = (type: string, title: string, description: string) =>
  `---\ntype: ${type}\ntitle: ${title}\ndescription: ${description}\n---\n\nThe fact.\n`

async function write(rel: string, text: string): Promise<void> {
  await mkdir(join(repo, rel, '..'), { recursive: true })
  await writeFile(join(repo, rel), text, 'utf8')
}

const read = (rel: string) => readFile(join(repo, rel), 'utf8').catch(() => null)

describe('memory-index', () => {
  it('writes the index in the same pass as the memory that was added', async () => {
    await write('memory/shell.md', memory('environment', 'Shell quirks', 'bare node is broken'))

    const result = await memoryIndex(repo, added('memory/shell.md'))

    expect(result.changed).toEqual([MEMORY_INDEX])
    expect(await read(MEMORY_INDEX)).toContain(
      '[[memory/shell.md|Shell quirks]] — bare node is broken',
    )
    expect(await read(MEMORY_INDEX)).toContain('## environment')
  })

  it('does nothing at all when the commit touches no memory', async () => {
    // The common case by a distance: this runs on every commit and most commits
    // are note edits. Asserted by the index never appearing, which is the only
    // observable difference between "returned early" and "scanned and found
    // nothing".
    await write('memory/shell.md', memory('environment', 'Shell quirks', 'bare node is broken'))

    const result = await memoryIndex(repo, added('notes/plan.md'))

    expect(result.changed).toEqual([])
    expect(await read(MEMORY_INDEX)).toBeNull()
  })

  it('indexes the whole tree, not just the file that was staged', async () => {
    // Indexing from the diff would drop every memory this commit did not touch.
    await write('memory/a.md', memory('convention', 'A', 'the first'))
    await write('memory/b.md', memory('convention', 'B', 'the second'))

    await memoryIndex(repo, added('memory/b.md'))

    const index = (await read(MEMORY_INDEX))!
    expect(index).toContain('[[memory/a.md|A]]')
    expect(index).toContain('[[memory/b.md|B]]')
  })

  it('never lists a personal memory, because the index is committed', async () => {
    // The one rule here whose failure is worse than untidiness (D65).
    await write('memory/shared.md', memory('convention', 'Shared', 'everyone sees this'))
    await write('memory/salary.local.md', memory('person', 'Salary', 'nobody else sees this'))

    await memoryIndex(repo, added('memory/shared.md'))

    const index = (await read(MEMORY_INDEX))!
    expect(index).toContain('Shared')
    expect(index).not.toContain('Salary')
    expect(index).not.toContain('salary.local.md')
  })

  it('does not run for a commit whose only memory is a personal one', async () => {
    await write('memory/salary.local.md', memory('person', 'Salary', 'private'))

    const result = await memoryIndex(repo, added('memory/salary.local.md'))

    expect(result.changed).toEqual([])
    expect(await read(MEMORY_INDEX)).toBeNull()
  })

  it('reports no change when the index on disk is already right', async () => {
    // A `changed` entry the runner restages for a file nothing rewrote is an
    // empty commit, on every memory edit that did not move a title.
    await write('memory/a.md', memory('convention', 'A', 'the first'))
    await memoryIndex(repo, added('memory/a.md'))
    const before = await read(MEMORY_INDEX)

    const again = await memoryIndex(repo, added('memory/a.md'))

    expect(again.changed).toEqual([])
    expect(await read(MEMORY_INDEX)).toBe(before)
  })

  it('re-indexes under the new path after a rename', async () => {
    await write('memory/old.md', memory('convention', 'A', 'the first'))
    await memoryIndex(repo, added('memory/old.md'))
    await rm(join(repo, 'memory/old.md'))
    await write('memory/new.md', memory('convention', 'A', 'the first'))

    const result = await memoryIndex(repo, {
      ...NOTHING,
      renamed: [{ from: 'memory/old.md', to: 'memory/new.md' }],
    })

    expect(result.changed).toEqual([MEMORY_INDEX])
    const index = (await read(MEMORY_INDEX))!
    expect(index).toContain('[[memory/new.md|A]]')
    expect(index).not.toContain('memory/old.md')
  })

  it('re-indexes when a memory is deleted, so the index stops naming it', async () => {
    // The reason `StagedChanges` carries deletions at all. The four transforms
    // that predate this one rewrite the changed file itself, so a file going
    // away is nothing to them; this one's output is a list of what EXISTS.
    await write('memory/a.md', memory('convention', 'A', 'the first'))
    await write('memory/b.md', memory('convention', 'B', 'the second'))
    await memoryIndex(repo, added('memory/a.md', 'memory/b.md'))
    expect(await read(MEMORY_INDEX)).toContain('memory/b.md')

    await rm(join(repo, 'memory/b.md'))
    const result = await memoryIndex(repo, { ...NOTHING, deleted: ['memory/b.md'] })

    expect(result.changed).toEqual([MEMORY_INDEX])
    const index = (await read(MEMORY_INDEX))!
    expect(index).toContain('[[memory/a.md|A]]')
    expect(index).not.toContain('memory/b.md')
  })

  it('returns to the empty form when the last memory goes', async () => {
    await write('memory/only.md', memory('convention', 'Only', 'the last one standing'))
    await memoryIndex(repo, added('memory/only.md'))
    await rm(join(repo, 'memory/only.md'))

    await memoryIndex(repo, { ...NOTHING, deleted: ['memory/only.md'] })

    const index = (await read(MEMORY_INDEX))!
    expect(index).toContain('no memories yet')
    expect(index).not.toContain('memory/only.md')
  })

  it('indexes a memory whose frontmatter is broken rather than refusing it', async () => {
    await write('memory/half.md', '---\ntype: [unclosed\n---\n\nA fact mid-edit.\n')

    const result = await memoryIndex(repo, added('memory/half.md'))

    expect(result.changed).toEqual([MEMORY_INDEX])
    expect(await read(MEMORY_INDEX)).toContain('[[memory/half.md|half]] — A fact mid-edit.')
  })
})

describe('memory-index inside the runner', () => {
  const settings = { 'memory-index': true } as const

  it('restages the index so it joins this commit', async () => {
    await write('memory/a.md', memory('convention', 'A', 'the first'))
    await plainGit(repo, ['add', '-A'])

    const run = await runPreCommit(repo, added('memory/a.md'), {
      settings,
      transforms: [{ name: 'memory-index', run: memoryIndex }],
    })

    expect(run.changed).toEqual([MEMORY_INDEX])
    expect(run.failed).toEqual([])
    // Staged, not merely written: `git diff --cached --name-only` is what the
    // commit is about to record.
    const staged = await plainGit(repo, ['diff', '--cached', '--name-only'])
    expect(staged).toContain(MEMORY_INDEX)
  })

  it('lets the commit through when the indexer throws (FR-9)', async () => {
    const run = await runPreCommit(repo, added('memory/a.md'), {
      settings,
      transforms: [
        {
          name: 'memory-index',
          run: () => Promise.reject(new Error('indexer exploded')),
        },
      ],
    })

    expect(run.failed).toEqual([{ name: 'memory-index', error: 'indexer exploded' }])
    expect(run.changed).toEqual([])
  })
})
