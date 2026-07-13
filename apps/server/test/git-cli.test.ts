import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { git, gitBuffer, isAncestor, parseNameStatusZ, tryGit } from '../src/git/git'
import { commitAll, initBareRepo, initWorkdir } from '../src/test/git'

const cleanups: string[] = []
afterAll(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-git-'))
  cleanups.push(dir)
  return dir
}

describe('git wrapper', () => {
  it('init/commit/rev-parse round-trip', async () => {
    const dir = await scratch()
    const work = await initWorkdir(join(dir, 'w'))
    await writeFile(join(work, 'a.md'), 'hello\n')
    const sha = await commitAll(work, 'first')
    expect(await git(['rev-parse', 'HEAD'], work)).toBe(sha)
  })

  it('gitBuffer returns exact bytes (no trailing-newline mangling)', async () => {
    const dir = await scratch()
    const work = await initWorkdir(join(dir, 'w'))
    await writeFile(join(work, 'a.md'), 'no trailing newline')
    const sha = await commitAll(work, 'c')
    const buf = await gitBuffer(['show', `${sha}:a.md`], work)
    expect(buf.toString('utf8')).toBe('no trailing newline')
  })

  it('isAncestor', async () => {
    const dir = await scratch()
    const work = await initWorkdir(join(dir, 'w'))
    await writeFile(join(work, 'a.md'), '1\n')
    const first = await commitAll(work, 'one')
    await writeFile(join(work, 'a.md'), '2\n')
    const second = await commitAll(work, 'two')
    expect(await isAncestor(work, first, second)).toBe(true)
    expect(await isAncestor(work, second, first)).toBe(false)
  })

  it('tryGit reports failure without throwing', async () => {
    const dir = await scratch()
    const work = await initWorkdir(join(dir, 'w'))
    const res = await tryGit(['rev-parse', 'origin/main'], work)
    expect(res.ok).toBe(false)
  })

  it('parseNameStatusZ handles A/M/D and renames', () => {
    const out = ['M\0a.md', 'A\0new.md', 'D\0gone.md', 'R100\0old.md\0moved.md', ''].join('\0')
    expect(parseNameStatusZ(out)).toEqual([
      { status: 'M', path: 'a.md' },
      { status: 'A', path: 'new.md' },
      { status: 'D', path: 'gone.md' },
      { status: 'R', path: 'moved.md', oldPath: 'old.md', similarity: 100 },
    ])
  })

  it('push to a bare remote and fetch back', async () => {
    const dir = await scratch()
    const bare = await initBareRepo(join(dir, 'bare.git'))
    const work = await initWorkdir(join(dir, 'w'))
    await git(['remote', 'add', 'origin', bare], work)
    await writeFile(join(work, 'a.md'), 'x\n')
    const sha = await commitAll(work, 'c')
    await git(['push', '-u', 'origin', 'main'], work)
    const work2 = await initWorkdir(join(dir, 'w2'))
    await git(['remote', 'add', 'origin', bare], work2)
    await git(['fetch', 'origin'], work2)
    expect(await git(['rev-parse', 'origin/main'], work2)).toBe(sha)
  })
})
