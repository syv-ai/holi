import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createManagedCommitProvenance } from '../src/main/managed-commit-provenance'
import { openRepo } from '../src/main/git'
import { cleanupFixtures, makeClone, makeRemote } from './helpers/git-fixtures'

const roots: string[] = []

afterAll(async () => {
  await cleanupFixtures()
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function stateFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-581-provenance-'))
  roots.push(dir)
  return join(dir, 'state.json')
}

describe('managed commit provenance', () => {
  it('persists exact real managed commits and rejects a changed session generation', async () => {
    const root = await makeClone(await makeRemote())
    const file = await stateFile()
    let identity: { accountId: number; generation: number } | null = {
      accountId: 31,
      generation: 4,
    }
    const recorder = createManagedCommitProvenance({
      file,
      remote: 'owner/repo',
      identity: () => identity,
      subscribed: async () => true,
    })
    await writeFile(join(root, 'note.md'), 'committed\n')
    const oid = await openRepo(root, {
      commitProvenance: {
        begin: (path) => recorder.begin(path),
        record: (capture, path, sha) => recorder.record(capture, path, sha),
      },
    }).commitAll('Update note', ['note.md'])
    expect(oid).toMatch(/^[0-9a-f]{40}$/)
    const saved = JSON.parse(await readFile(file, 'utf8')) as {
      records: Array<{ oid: string; accountId: number }>
    }
    expect(saved.records).toHaveLength(1)
    expect(saved.records[0]).toMatchObject({ oid, accountId: 31 })

    const capture = await recorder.begin(root)
    identity = { accountId: 31, generation: 5 }
    await recorder.record(capture, root, 'b'.repeat(40))
    const afterRelogin = JSON.parse(await readFile(file, 'utf8')) as {
      records: Array<{ oid: string }>
    }
    expect(afterRelogin.records).toHaveLength(1)
  })

  it('rejects corrupt state rather than treating it as trusted empty history', async () => {
    const file = await stateFile()
    const root = await makeClone(await makeRemote())
    await writeFile(file, '{ broken')
    const recorder = createManagedCommitProvenance({
      file,
      remote: 'owner/repo',
      identity: () => ({ accountId: 2, generation: 0 }),
      subscribed: async () => true,
    })
    const capture = await recorder.begin(root)
    await expect(recorder.record(capture, root, 'a'.repeat(40))).rejects.toThrow(/invalid/)
  })
})
