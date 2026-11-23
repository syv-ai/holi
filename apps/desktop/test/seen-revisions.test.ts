import { mkdtemp, rm, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createSeenRevisions } from '../src/main/vault/subscriptions'

import {
  cleanupFixtures,
  commitFile,
  makeClone,
  makeRemote,
  plainGit,
} from './helpers/git-fixtures'

afterAll(cleanupFixtures)

const revisions = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)]

describe('seen revisions', () => {
  let root: string
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })
  async function setup() {
    root = await mkdtemp(join(tmpdir(), 'seen-revisions-'))
    return join(root, 'state.json')
  }
  const ancestry = async (a: string, b: string) => revisions.indexOf(a) <= revisions.indexOf(b)

  it('persists displayed revisions, preserves history, and ignores stale acknowledgements', async () => {
    const file = await setup()
    const first = createSeenRevisions(file)
    expect(await first.acknowledge('owner/repo', 'notes/a.md', revisions[0]!, ancestry)).toEqual({
      seen: revisions[0],
      previous: null,
    })
    await first.acknowledge('owner/repo', 'notes/a.md', revisions[1]!, ancestry)
    expect(await createSeenRevisions(file).get('owner/repo', 'notes/a.md')).toEqual({
      seen: revisions[1],
      previous: revisions[0],
    })
    expect(await first.acknowledge('owner/repo', 'notes/a.md', revisions[0]!, ancestry)).toEqual({
      seen: revisions[1],
      previous: revisions[0],
    })
    await first.acknowledge('owner/repo', 'notes/a.md', revisions[1]!, ancestry)
    expect(await first.get('owner/repo', 'notes/a.md')).toEqual({
      seen: revisions[1],
      previous: revisions[0],
    })
  })

  it('normalizes hashes, rejects divergent history and invalid/secret paths without changing state', async () => {
    const file = await setup()
    const store = createSeenRevisions(file)
    await store.acknowledge('owner/repo', 'notes/a.md', revisions[0]!.toUpperCase(), ancestry)
    expect(await store.get('owner/repo', 'notes/a.md')).toEqual({
      seen: revisions[0],
      previous: null,
    })
    await expect(
      store.acknowledge('owner/repo', 'notes/a.md', revisions[2]!, async () => false),
    ).rejects.toThrow()
    await expect(store.acknowledge('owner/repo', '.env', revisions[1]!, ancestry)).rejects.toThrow()
    await store.acknowledge('owner/repo', 'constructor', revisions[1]!, ancestry)
    expect(await store.get('owner/repo', 'constructor')).toEqual({
      seen: revisions[1],
      previous: null,
    })
    expect(await store.get('owner/repo', 'notes/a.md')).toEqual({
      seen: revisions[0],
      previous: null,
    })
  })

  it('serializes concurrent handles and reports malformed or unwritable storage', async () => {
    const file = await setup()
    const one = createSeenRevisions(file)
    const two = createSeenRevisions(file)
    await Promise.all([
      one.acknowledge('owner/repo', 'notes/a.md', revisions[0]!, ancestry),
      two.acknowledge('owner/repo', 'notes/b.md', revisions[0]!, ancestry),
    ])
    expect((await one.read('owner/repo')).size).toBe(2)
    const invalid = join(root, 'bad.json')
    await writeFile(invalid, '{')
    await expect(createSeenRevisions(invalid).read('owner/repo')).rejects.toThrow()
    const directory = join(root, 'directory')
    await mkdir(directory)
    await expect(
      createSeenRevisions(directory).acknowledge(
        'owner/repo',
        'notes/c.md',
        revisions[0]!,
        ancestry,
      ),
    ).rejects.toThrow()
  })
  it('uses real Git ancestry without regressing or losing comparison endpoints', async () => {
    const file = await setup()
    const repo = await makeClone(await makeRemote())
    const hashes: string[] = []
    for (const content of ['one', 'two', 'three']) {
      await commitFile(repo, 'note.md', content)
      hashes.push((await plainGit(repo, ['rev-parse', 'HEAD'])).trim())
    }
    const ancestor = async (a: string, b: string) =>
      (await plainGit(repo, ['merge-base', a, b])).trim() === a
    const store = createSeenRevisions(file)
    for (const hash of hashes) await store.acknowledge('owner/repo', 'note.md', hash, ancestor)
    const expected = { seen: hashes[2], previous: hashes[1] }
    expect(await store.acknowledge('owner/repo', 'note.md', hashes[0]!, ancestor)).toEqual(expected)
    expect(await store.acknowledge('owner/repo', 'note.md', hashes[2]!, ancestor)).toEqual(expected)
    await plainGit(repo, ['checkout', '--detach', hashes[0]!])
    await commitFile(repo, 'note.md', 'divergent')
    const divergent = (await plainGit(repo, ['rev-parse', 'HEAD'])).trim()
    await expect(store.acknowledge('owner/repo', 'note.md', divergent, ancestor)).rejects.toThrow()
    await expect(
      store.acknowledge('owner/repo', 'note.md', 'f'.repeat(40), ancestor),
    ).rejects.toThrow()
    expect(await createSeenRevisions(file).get('owner/repo', 'note.md')).toEqual(expected)
  })

  it('isolates remotes and paths and preserves prior state when publication fails', async () => {
    const file = await setup()
    const store = createSeenRevisions(file)
    expect(await store.get('owner/repo', 'new.md')).toBeNull()
    await Promise.all([
      store.acknowledge('owner/repo', 'note.md', revisions[0]!, ancestry),
      createSeenRevisions(file).acknowledge('other/repo', 'note.md', revisions[1]!, ancestry),
    ])
    expect(await store.get('other/repo', 'note.md')).toEqual({ seen: revisions[1], previous: null })
    expect(await store.get('owner/repo', 'renamed.md')).toBeNull()
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    const before = await readFile(file, 'utf8')
    await mkdir(`${file}.tmp`)
    await expect(
      store.acknowledge('owner/repo', 'note.md', revisions[1]!, ancestry),
    ).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(before)
    await rm(`${file}.tmp`, { recursive: true })
    expect(await createSeenRevisions(file).get('owner/repo', 'note.md')).toEqual({
      seen: revisions[0],
      previous: null,
    })
  })

  it('rejects unsafe inputs and malformed stored records without replacing them', async () => {
    const file = await setup()
    const store = createSeenRevisions(file)
    for (const path of [
      '',
      '../note.md',
      'notes//note.md',
      '.git/config',
      '.holi/memory/index.md',
      'USER.local.md',
      'notes/.secrets',
    ]) {
      await expect(store.acknowledge('owner/repo', path, revisions[0]!, ancestry)).rejects.toThrow()
    }
    await expect(store.read('invalid')).rejects.toThrow()
    await expect(
      store.acknowledge('owner/repo', 'note.md', 'not-a-sha', ancestry),
    ).rejects.toThrow()
    for (const record of [
      { seen: 123, previous: null },
      { seen: revisions[0], previous: false },
    ]) {
      const text = JSON.stringify({ version: 1, remotes: { 'owner/repo': { 'note.md': record } } })
      await writeFile(file, text)
      await expect(
        store.acknowledge('owner/repo', 'note.md', revisions[1]!, ancestry),
      ).rejects.toThrow()
      expect(await readFile(file, 'utf8')).toBe(text)
    }
    const invalidPath = JSON.stringify({
      version: 1,
      remotes: { 'owner/repo': { '.env': { seen: revisions[0], previous: null } } },
    })
    await writeFile(file, invalidPath)
    await expect(store.read('owner/repo')).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(invalidPath)
  })
})
