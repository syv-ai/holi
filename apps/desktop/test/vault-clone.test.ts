/**
 * Getting a clone — by cloning it, or by adopting what is already there.
 *
 * The adoption path is the one with teeth. `vaults.remove` deliberately leaves
 * the clone on disk, possibly holding unpublished commits, so an occupied path
 * is a normal state rather than a corrupt one — and a re-clone is exactly what
 * would destroy that work. Nothing here ever deletes anything.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClonePathInUse, ensureClone } from '../src/main/vault/clone'
import { clonePathFor } from '../src/main/vault/registry'
import {
  cleanupFixtures,
  commitFile,
  makeClone,
  makeRemote,
  plainGit,
  tmp,
} from './helpers/git-fixtures'

afterAll(cleanupFixtures)

const REMOTE = 'syv-ai/notes'

/** A managed root with `syv-ai/notes` already cloned into the right place. */
async function rootWithClone(): Promise<{ root: string; dest: string; origin: string }> {
  const origin = await makeRemote()
  const root = await tmp('holi-root-')
  const dest = clonePathFor(root, REMOTE)
  await mkdir(join(root, 'syv-ai'), { recursive: true })
  await plainGit(root, ['clone', origin, dest])
  await plainGit(dest, ['config', 'user.name', 'Holi Test'])
  await plainGit(dest, ['config', 'user.email', 'test@holi.invalid'])
  return { root, dest, origin }
}

describe('ensureClone', () => {
  it('clones when the path is empty', async () => {
    const root = await tmp('holi-root-')
    const { repo, outcome } = await ensureClone({ root, remote: REMOTE, url: await makeRemote() })

    expect(outcome).toEqual({ kind: 'cloned' })
    expect(repo.root).toBe(clonePathFor(root, REMOTE))
    expect(await readFile(join(repo.root, 'README.md'), 'utf8')).toBe('# Vault\n')
  })

  it('creates the owner directory on the way', async () => {
    const root = await tmp('holi-root-')
    const { repo } = await ensureClone({ root, remote: REMOTE, url: await makeRemote() })
    expect(repo.root).toBe(join(root, 'syv-ai', 'notes'))
  })

  it('adopts an existing clone, keeping its unpublished commits', async () => {
    // The assertion this whole decision exists for. Remove a vault, make a
    // local commit, add it back — the work must still be there.
    const { root, dest } = await rootWithClone()
    await commitFile(dest, 'unpublished.md', 'work that never left this machine\n')

    const { repo, outcome } = await ensureClone({ root, remote: REMOTE })

    expect(outcome).toEqual({ kind: 'adopted' })
    expect(repo.root).toBe(dest)
    expect(await readFile(join(dest, 'unpublished.md'), 'utf8')).toBe(
      'work that never left this machine\n',
    )
    expect((await repo.status()).ahead).toBe(1)
  })

  it('adopts a clone whose origin is not GitHub-shaped', async () => {
    // A `file:///` origin cannot be compared to an owner/repo, and the
    // directory is at the path Holi itself computes under the managed root —
    // so it is Holi's clone by construction. This is also what lets the whole
    // sync loop be exercised with no GitHub token at all.
    const { root, dest } = await rootWithClone()
    const origin = await plainGit(dest, ['remote', 'get-url', 'origin'])
    expect(origin.startsWith('/')).toBe(true) // a local path, not a GitHub URL

    const { outcome } = await ensureClone({ root, remote: REMOTE })
    expect(outcome).toEqual({ kind: 'adopted' })
  })

  it('adopts a clone whose GitHub origin matches the requested remote', async () => {
    const { root, dest } = await rootWithClone()
    await plainGit(dest, ['remote', 'set-url', 'origin', `https://github.com/${REMOTE}.git`])

    const { outcome } = await ensureClone({ root, remote: REMOTE })
    expect(outcome).toEqual({ kind: 'adopted' })
  })

  it('adopts an ssh-form GitHub origin for the same remote', async () => {
    const { root, dest } = await rootWithClone()
    await plainGit(dest, ['remote', 'set-url', 'origin', `git@github.com:${REMOTE}.git`])

    const { outcome } = await ensureClone({ root, remote: REMOTE })
    expect(outcome).toEqual({ kind: 'adopted' })
  })

  it('refuses a clone whose GitHub origin names a different repo', async () => {
    const { root, dest } = await rootWithClone()
    await plainGit(dest, ['remote', 'set-url', 'origin', 'https://github.com/someone/else.git'])

    const err = await ensureClone({ root, remote: REMOTE }).catch((e) => e)
    expect(err).toBeInstanceOf(ClonePathInUse)
    expect((err as ClonePathInUse).foundRemote).toBe('someone/else')
    // And it changed nothing.
    expect(await readFile(join(dest, 'README.md'), 'utf8')).toBe('# Vault\n')
  })

  it('refuses a directory that is not a repo, and leaves it alone', async () => {
    const root = await tmp('holi-root-')
    const dest = clonePathFor(root, REMOTE)
    await mkdir(dest, { recursive: true })
    await writeFile(join(dest, 'someones-work.txt'), 'do not delete me\n', 'utf8')

    const err = await ensureClone({ root, remote: REMOTE, url: await makeRemote() }).catch((e) => e)
    expect(err).toBeInstanceOf(ClonePathInUse)
    expect((err as ClonePathInUse).foundRemote).toBeNull()
    expect(await readFile(join(dest, 'someones-work.txt'), 'utf8')).toBe('do not delete me\n')
  })

  it('refuses a repo with no origin', async () => {
    const { root, dest } = await rootWithClone()
    await plainGit(dest, ['remote', 'remove', 'origin'])

    const err = await ensureClone({ root, remote: REMOTE }).catch((e) => e)
    expect(err).toBeInstanceOf(ClonePathInUse)
    expect((err as ClonePathInUse).foundRemote).toBeNull()
  })

  it('refuses a remote that is not owner/repo before touching the filesystem', async () => {
    const root = await tmp('holi-root-')
    await expect(ensureClone({ root, remote: '../../etc/passwd' })).rejects.toThrow(/owner\/repo/)
  })
})
