/**
 * `head()` and `rangeFiles()` — the two git questions an agent turn asks.
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
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  cleanupFixtures,
  commitFile,
  makeClone,
  makeRemote,
  plainGit,
} from './helpers/git-fixtures'
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
    expect(files[0]).toMatchObject({ status: expect.stringMatching(/^R/), added: 0, removed: 0 })
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

  it('fails honestly when a consumed historical read exceeds its output budget', async () => {
    const { dir, repo } = await repoAt()
    const base = (await repo.head())!
    for (let i = 0; i < 150; i++)
      await writeFile(join(dir, `large-${i.toString().padStart(3, '0')}.md`), 'x\n')
    await plainGit(dir, ['add', '-A'])
    await plainGit(dir, ['commit', '-m', 'many files'])
    await expect(
      repo.rangeFiles(base, (await repo.head())!, { maxBuffer: 1024, timeout: 10_000 }),
    ).rejects.toThrow(/output resource limit/)
  })

  it('keeps tabs and further tabs in literal filenames', async () => {
    const { dir, repo } = await repoAt()
    const base = (await repo.head())!
    await writeFile(join(dir, 'literal\tname\t.md'), 'one\ntwo\n')
    await plainGit(dir, ['add', '-A'])
    await plainGit(dir, ['commit', '-m', 'tabbed path'])
    expect(await repo.rangeFiles(base, (await repo.head())!)).toEqual([
      { path: 'literal\tname\t.md', status: 'A', added: 2, removed: 0 },
    ])
  })

  it('rejects revision expressions and non-commit/tree objects', async () => {
    const { dir, repo } = await repoAt()
    const sha = (await repo.head())!
    expect(await repo.rangeFiles(`${sha}^`, sha)).toEqual([])
    expect(await repo.rangeFiles('--output=/tmp/out', sha)).toEqual([])
  })

  it('keeps generic history revisions while fencing option injection in show', async () => {
    const { dir, repo } = await repoAt()
    const before = (await repo.head())!
    await commitFile(dir, 'README.md', '# changed\n')
    const end = (await repo.head())!
    expect(await repo.show(`${end}^`, 'README.md')).toBe('# Vault\n')
    const outside = join(dir, 'must-not-be-created')
    await expect(repo.show(`--output=${outside}`, 'README.md')).rejects.toThrow()
    await expect(readFile(outside, 'utf8')).rejects.toThrow()
    expect(await repo.show(before, 'README.md')).toBe('# Vault\n')
  })

  it('kills a SIGTERM-resistant historical read at its deadline and reaps it', async () => {
    const { dir } = await repoAt()
    const wrapper = join(dir, 'git-wrapper.cjs')
    const pidFile = join(dir, 'child.pid')
    await writeFile(
      wrapper,
      `#!/usr/bin/env node\nconst { spawnSync } = require('node:child_process');\nconst fs = require('node:fs');\nif (process.argv[2] === 'diff') { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); if (process.env.HOLI_TEST_RESIST === '1') process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); } else { const r = spawnSync('git', process.argv.slice(2), { cwd: process.cwd(), encoding: 'utf8' }); process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); process.exit(r.status || 0); }\n`,
      { mode: 0o700 },
    )
    await chmod(wrapper, 0o700)
    const repo = openRepo(dir, { gitPath: wrapper, env: { HOLI_TEST_RESIST: '1' } })
    const base = (await openRepo(dir).head())!
    const end = (await openRepo(dir).head())!
    await expect(
      repo.rangeFiles(base, end, { maxBuffer: 1024 * 1024, timeout: 1000 }),
    ).rejects.toThrow(/time resource limit/)
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()

    const ordinaryPidFile = join(dir, 'ordinary-child.pid')
    const ordinaryWrapper = join(dir, 'ordinary-git-wrapper.cjs')
    await writeFile(
      ordinaryWrapper,
      `#!/usr/bin/env node\nconst { spawnSync } = require('node:child_process');\nconst fs = require('node:fs');\nif (process.argv[2] === 'diff') { fs.writeFileSync(${JSON.stringify(ordinaryPidFile)}, String(process.pid)); setInterval(() => {}, 1000); } else { const r = spawnSync('git', process.argv.slice(2), { cwd: process.cwd(), encoding: 'utf8' }); process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); process.exit(r.status || 0); }\n`,
      { mode: 0o700 },
    )
    const ordinaryRepo = openRepo(dir, { gitPath: ordinaryWrapper })
    await expect(
      ordinaryRepo.rangeFiles(base, end, { maxBuffer: 1024 * 1024, timeout: 1000 }),
    ).rejects.toThrow(/time resource limit/)
    const ordinaryPid = Number(await readFile(ordinaryPidFile, 'utf8'))
    expect(() => process.kill(ordinaryPid, 0)).toThrow()
  })

  it('is empty when a sha is unreachable, because a dropped range is not an error', async () => {
    // A turn record outlives the commits it names — a reset, a re-clone. The
    // panel says "this turn's history is gone"; it must not be handed a throw.
    const { repo } = await repoAt()
    const sha = (await repo.head())!
    expect(await repo.rangeFiles('0'.repeat(40), sha)).toEqual([])
  })
})
