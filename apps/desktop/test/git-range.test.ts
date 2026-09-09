/**
 * `head()` and `rangeFiles()` — the two git questions an agent turn asks (D88).
 *
 * A turn is a commit range, so what it changed is `git diff base..end` and
 * nothing else. That is the whole reason it is a range rather than a tool-level
 * record: git catches the files the agent changed through `Bash` — a `sed`, an
 * `mv`, a script — that a `Write|Edit|MultiEdit` matcher never sees.
 *
 * Real repositories, no mocks, for the reason `git.test.ts` gives: a mock would
 * test this file's idea of git rather than git. Two of the cases here exist
 * *because* git surprised us — see `--numstat` below.
 */
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupFixtures, commitFile, makeClone, makeRemote, plainGit } from './helpers/git-fixtures'
import { openRepo } from '../src/main/git'

afterAll(cleanupFixtures)

/** A clone with one seeded commit, plus its repo handle. */
async function repoAt(): Promise<{ dir: string; repo: ReturnType<typeof openRepo> }> {
  const dir = await makeClone(await makeRemote())
  return { dir, repo: openRepo(dir) }
}

describe('head()', () => {
  it('is the current commit', async () => {
    const { dir, repo } = await repoAt()
    expect(await repo.head()).toBe(await plainGit(dir, ['rev-parse', 'HEAD']))
  })

  it('moves with a new commit', async () => {
    const { dir, repo } = await repoAt()
    const before = await repo.head()
    await commitFile(dir, 'a.md', 'one\n')
    expect(await repo.head()).not.toBe(before)
  })

  it('is null on an unborn branch, which is a vault with no commits', async () => {
    const dir = await makeClone(await makeRemote(), 'unborn')
    await plainGit(dir, ['checkout', '--orphan', 'fresh'])
    await plainGit(dir, ['rm', '-rf', '--cached', '.'])
    expect(await openRepo(dir).head()).toBeNull()
  })
})

describe('rangeFiles()', () => {
  it('reports an added file as A, with nothing removed', async () => {
    const { dir, repo } = await repoAt()
    const base = (await repo.head())!
    await commitFile(dir, 'added.md', 'one\ntwo\n')
    const files = await repo.rangeFiles(base, (await repo.head())!)
    expect(files).toEqual([{ path: 'added.md', status: 'A', added: 2, removed: 0 }])
  })

  it('reports a modified file’s real line counts', async () => {
    const { dir, repo } = await repoAt()
    await commitFile(dir, 'note.md', 'one\ntwo\nthree\n')
    const base = (await repo.head())!
    await commitFile(dir, 'note.md', 'one\nCHANGED\nthree\nfour\n')
    const files = await repo.rangeFiles(base, (await repo.head())!)
    expect(files).toEqual([{ path: 'note.md', status: 'M', added: 2, removed: 1 }])
  })

  it('reports a deleted file as D', async () => {
    const { dir, repo } = await repoAt()
    await commitFile(dir, 'gone.md', 'one\n')
    const base = (await repo.head())!
    await rm(join(dir, 'gone.md'))
    await plainGit(dir, ['add', '-A'])
    await plainGit(dir, ['commit', '-m', 'delete'])
    const files = await repo.rangeFiles(base, (await repo.head())!)
    expect(files).toEqual([{ path: 'gone.md', status: 'D', added: 0, removed: 1 }])
  })

  it('reports a rename once, at its new path', async () => {
    // `--name-status -z` spends THREE fields on a rename (`R100`, old, new)
    // where everything else spends two. Parsed as two, the next file's status
    // reads as a path and the list quietly goes wrong from there.
    const { dir, repo } = await repoAt()
    await commitFile(dir, 'before.md', 'one\ntwo\nthree\n')
    const base = (await repo.head())!
    await plainGit(dir, ['mv', 'before.md', 'after.md'])
    await plainGit(dir, ['commit', '-m', 'rename'])
    const files = await repo.rangeFiles(base, (await repo.head())!)
    expect(files).toHaveLength(1)
    expect(files[0]!.path).toBe('after.md')
    // `R100` for an exact rename; the number is the similarity score.
    expect(files[0]!.status.startsWith('R')).toBe(true)
  })

  it('handles several files in one range, and keeps their counts apart', async () => {
    const { dir, repo } = await repoAt()
    const base = (await repo.head())!
    await commitFile(dir, 'one.md', 'a\n')
    await commitFile(dir, 'two.md', 'a\nb\nc\n')
    const files = await repo.rangeFiles(base, (await repo.head())!)
    expect(files).toEqual([
      { path: 'one.md', status: 'A', added: 1, removed: 0 },
      { path: 'two.md', status: 'A', added: 3, removed: 0 },
    ])
  })

  it('reports a binary file as zero rather than as git’s dash', async () => {
    const { dir, repo } = await repoAt()
    const base = (await repo.head())!
    await writeFile(join(dir, 'pic.bin'), Buffer.from([0, 1, 2, 0, 255]))
    await plainGit(dir, ['add', '-A'])
    await plainGit(dir, ['commit', '-m', 'binary'])
    const files = await repo.rangeFiles(base, (await repo.head())!)
    expect(files).toEqual([{ path: 'pic.bin', status: 'A', added: 0, removed: 0 }])
  })

  it('is empty for an empty range', async () => {
    const { repo } = await repoAt()
    const sha = (await repo.head())!
    expect(await repo.rangeFiles(sha, sha)).toEqual([])
  })

  it('is empty when a sha is unreachable, because a dropped range is not an error', async () => {
    // A turn record outlives the commits it names — a reset, a re-clone. The
    // panel says "this turn's history is gone"; it must not be handed a throw.
    const { repo } = await repoAt()
    const sha = (await repo.head())!
    expect(await repo.rangeFiles('0'.repeat(40), sha)).toEqual([])
  })
})
