/**
 * `git check-ignore`, wrapped — against real repos, because the whole point of
 * shelling out is that git's answer is the one that counts. A fake would be the
 * second opinion this module exists to avoid.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { cleanupFixtures, makeClone, makeRemote, plainGit } from './helpers/git-fixtures'
import { ignoredPaths } from '../src/main/vault/git-ignored'
import { scanVault } from '../src/main/vault/vault-store'

let repo: string

beforeEach(async () => {
  repo = await makeClone(await makeRemote(), 'ignored')
})

afterAll(cleanupFixtures)

async function write(rel: string, text: string): Promise<void> {
  await mkdir(join(repo, rel, '..'), { recursive: true })
  await writeFile(join(repo, rel), text, 'utf8')
}

describe('ignoredPaths', () => {
  it('reports the ignored subset and nothing else', async () => {
    await write('.gitignore', '*.local.*\n')
    await write('notes/plan.md', '# plan\n')
    await write('notes/secret.local.md', 'private\n')

    expect(await ignoredPaths(repo, ['notes/plan.md', 'notes/secret.local.md'])).toEqual([
      'notes/secret.local.md',
    ])
  })

  it('returns an empty list when nothing is ignored, rather than treating exit 1 as failure', async () => {
    // `git check-ignore` exits 1 when it matched nothing. A vault where nothing
    // is ignored is the ordinary case, not a broken one.
    await write('.gitignore', '*.local.*\n')
    await write('notes/plan.md', '# plan\n')

    expect(await ignoredPaths(repo, ['notes/plan.md'])).toEqual([])
  })

  it('honours a rule the name gives no hint of', async () => {
    // The whole reason this asks git instead of matching `.local.`: a vault can
    // ignore anything, and vaults seeded before D65 carry a bare `USER.md`.
    await write('.gitignore', 'USER.md\nbuild/\n')
    await write('USER.md', 'about me\n')
    await write('build/out.md', 'generated\n')
    await write('AGENTS.md', 'rules\n')

    const ignored = await ignoredPaths(repo, ['USER.md', 'build/out.md', 'AGENTS.md'])
    expect(ignored.sort()).toEqual(['USER.md', 'build/out.md'])
  })

  it('answers for a directory, so a wholly-ignored folder can dim too', async () => {
    await write('.gitignore', 'build/\n')
    await write('build/out.md', 'generated\n')

    expect(await ignoredPaths(repo, ['build'])).toEqual(['build'])
  })

  it('honours a negation, which is why this is not a regex in the renderer', async () => {
    await write('.gitignore', '*.local.*\n!keep.local.md\n')
    await write('drop.local.md', 'x\n')
    await write('keep.local.md', 'x\n')

    expect(await ignoredPaths(repo, ['drop.local.md', 'keep.local.md'])).toEqual(['drop.local.md'])
  })

  it('does not call a TRACKED file ignored, however well a rule matches it', async () => {
    // Git stops applying ignore rules once a path is in the index, and
    // `check-ignore` agrees by consulting it. A file committed before the rule
    // existed is ordinary content, and the tree should not dim it.
    await write('USER.md', 'about me\n')
    await plainGit(repo, ['add', '-f', 'USER.md'])
    await plainGit(repo, ['commit', '-m', 'track it'])
    await write('.gitignore', 'USER.md\n')

    expect(await ignoredPaths(repo, ['USER.md'])).toEqual([])
  })

  it('survives a path with spaces and non-ASCII', async () => {
    // `-z` in both directions, or git quotes and escapes these and every path
    // downstream is one that does not exist.
    await write('.gitignore', '*.local.*\n')
    await write('nøter/æøå note.local.md', 'x\n')

    expect(await ignoredPaths(repo, ['nøter/æøå note.local.md'])).toEqual([
      'nøter/æøå note.local.md',
    ])
  })

  it('is empty, never a throw, outside a git repository', async () => {
    // It decorates a tree; it does not decide what is in one. A directory that
    // is not a repo yet must render undimmed rather than not at all.
    const loose = await mkdtemp(join(tmpdir(), 'holi-not-a-repo-'))
    await writeFile(join(loose, 'a.md'), 'x\n', 'utf8')

    expect(await ignoredPaths(loose, ['a.md'])).toEqual([])
    await rm(loose, { recursive: true, force: true })
  })

  it('asks git nothing when handed no paths', async () => {
    expect(await ignoredPaths(repo, [])).toEqual([])
  })
})

describe('scanVault carries the answer to the tree', () => {
  it('reports ignored files AND directories on the snapshot', async () => {
    // The wiring, not the helper: the scan has to hand git its directories as
    // well as its files, or a wholly-ignored folder renders as ordinary content
    // with dimmed children hanging off it.
    await write('.gitignore', 'build/\n*.local.*\n')
    await write('notes/plan.md', '# plan\n')
    await write('notes/secret.local.md', 'private\n')
    await write('build/out.md', 'generated\n')

    const snap = await scanVault(repo)

    expect(snap.ignored).toContain('notes/secret.local.md')
    expect(snap.ignored).toContain('build/out.md')
    expect(snap.ignored).toContain('build')
    expect(snap.ignored).not.toContain('notes/plan.md')
    expect(snap.ignored).not.toContain('notes')
  })
})
