import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runVaultStorageCheck } from '../app/vault-storage-check'
import { createVaultStorage } from '../app/vault-storage'
import { createNodeFiles, nodeFiles } from './native-files-node'

const runId = randomUUID()
const suiteRoot = `/tmp/holi-588-suite-${runId}`
const evidenceRoot = `/tmp/holi-588-suite-evidence-${runId}`
const roots: string[] = []
async function root() {
  await mkdir(suiteRoot, { recursive: true })
  await mkdir(evidenceRoot, { recursive: true })
  const path = await mkdtemp(join(suiteRoot, 'root-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  await rm(suiteRoot, { recursive: true, force: true })
})

describe('vault storage with real directories', () => {
  it('runs the shared adversarial scenario on real roots and retains its evidence', async () => {
    const a = await root()
    const b = await root()
    const outside = await root()
    await writeFile(join(outside, 'note.md'), 'outside')
    await symlink(outside, join(a, 'linked'))
    await symlink(join(outside, 'note.md'), join(a, 'leaf-link.md'))
    await symlink(join(outside, 'missing.md'), join(a, 'dangling-link.md'))
    const result = await runVaultStorageCheck(nodeFiles, a, b, (phase) =>
      createNodeFiles(async (at) => {
        if (at === phase) throw new Error(`injected ${phase}`)
      }),
    )
    await writeFile(join(evidenceRoot, 'node-storage.json'), JSON.stringify(result, null, 2))
    expect(result).toMatchObject({ passed: 1, failed: 0, exactBytes: true, staleRejected: true })
    expect(await readFile(join(outside, 'note.md'), 'utf8')).toBe('outside')
  })

  it('keeps durable bytes intact at each real staging failure checkpoint', async () => {
    for (const phase of [
      'stage-open',
      'stage-write',
      'stage-sync',
      'stage-close',
      'publish',
    ] as const) {
      const base = await root()
      const setup = createVaultStorage(nodeFiles, { remote: 'holi/failure-setup', root: base })
      const prior = new TextEncoder().encode('durable previous bytes')
      const document = await setup.create('note.md', prior)
      const failing = createVaultStorage(
        createNodeFiles(async (at) => {
          if (at === phase) throw new Error(`injected ${phase}`)
        }),
        { remote: 'holi/failure-injection', root: base },
      )
      await expect(
        failing.save('note.md', new TextEncoder().encode('partial replacement'), document.revision),
      ).rejects.toThrow()
      expect([...(await setup.read('note.md')).bytes]).toEqual([...prior])
      expect(
        (await readdir(base)).filter((name) => name.startsWith('.holi-storage-stage-')),
      ).toEqual([])
    }
  })

  it('rejects traversal, case aliases, links and file/directory collisions', async () => {
    const base = await root()
    const outside = await root()
    const store = createVaultStorage(nodeFiles, { remote: 'holi/base', root: base })
    await store.create('Name.md', new TextEncoder().encode('safe'))
    await writeFile(join(outside, 'escape.md'), 'outside')
    await symlink(outside, join(base, 'linked'))
    await expect(store.read('../escape.md')).rejects.toThrow()
    await expect(store.read('missing/child.md')).rejects.toThrow()
    expect(await readdir(base)).not.toContain('missing')
    await expect(store.read('name.md')).rejects.toThrow()
    await expect(store.read('linked/escape.md')).rejects.toThrow()
    await expect(store.create('Name.md/child', new Uint8Array())).rejects.toThrow()
    expect(await readFile(join(outside, 'escape.md'), 'utf8')).toBe('outside')
  })

  it('does not publish local, secret, ignored or internal artifacts', async () => {
    const base = await root()
    const store = createVaultStorage(nodeFiles, { remote: 'holi/filtered', root: base })
    await mkdir(join(base, '.git'))
    await writeFile(join(base, '.git', 'hidden.md'), 'x')
    await writeFile(join(base, 'private.local.md'), 'x')
    await writeFile(join(base, '.env'), 'x')
    await writeFile(join(base, '.holi-storage-owned.tmp'), 'x')
    expect(await store.list()).toEqual([])
    await expect(store.read('.env')).rejects.toThrow()
  })
})
