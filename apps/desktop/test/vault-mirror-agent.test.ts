import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Hocuspocus } from '@hocuspocus/server'
import type { DocMeta } from '@holi/shared'
import { VaultMirror, type MirrorApi } from '../src/main/vault/vault-mirror'
import { SimClient, startRelay, waitUntil } from './helpers/relay'

const PORT = 5614
const URL = `ws://127.0.0.1:${PORT}`
const VAULT = 'v-agent'

let relay: Hocuspocus
beforeAll(async () => {
  relay = await startRelay(PORT)
})
afterAll(async () => {
  await relay.destroy()
})

function meta(path: string): DocMeta {
  return { id: randomUUID(), vaultId: VAULT, path, kind: 'note', createdAt: '', updatedAt: '' }
}

interface Fake {
  api: MirrorApi
  docs: DocMeta[]
}

function fakeApi(docs: DocMeta[]): Fake {
  const fake: Fake = {
    docs,
    api: {
      listDocs: async () => [...fake.docs],
      createNote: async (path) => {
        const m = meta(path)
        fake.docs.push(m)
        return m
      },
      deleteNote: async (docId) => {
        fake.docs = fake.docs.filter((d) => d.id !== docId)
      },
      takeSnapshot: async () => {},
    },
  }
  return fake
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

interface Rig {
  mirror: VaultMirror
  root: string
  activity: number[]
  materialized: string[]
}

async function makeMirror(fake: Fake): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-vma-'))
  const root = join(dir, 'work')
  const activity: number[] = []
  const materialized: string[] = []
  const mirror = new VaultMirror({
    vaultId: VAULT,
    workRoot: root,
    baseDir: join(dir, 'bases'),
    relayUrl: URL,
    token: 'tok',
    api: fake.api,
    turnIdleMs: 200,
    lifecycleDebounceMs: 150,
    onTurnActivity: (n) => activity.push(n),
    onMaterialize: (rel) => materialized.push(rel),
  })
  cleanups.push(async () => {
    await mirror.stop()
    await rm(dir, { recursive: true, force: true })
  })
  return { mirror, root, activity, materialized }
}

/** refresh() fire-and-forgets openEntry — the bridge appears asynchronously. */
async function waitForBridge(mirror: VaultMirror, rel: string) {
  await waitUntil(() => mirror.bridgeForPath(rel) !== null, 8000, `bridge for ${rel}`)
  return mirror.bridgeForPath(rel)!
}

describe('VaultMirror agent seams', { timeout: 15_000 }, () => {
  it('exposes path↔docId lookups and known paths for started entries', async () => {
    const a = meta('notes/a.md')
    const seed = new SimClient(URL, a.id)
    seed.text.insert(0, '# A\n')
    cleanups.push(async () => seed.destroy())
    const { mirror } = await makeMirror(fakeApi([a]))
    await mirror.start()
    await waitForBridge(mirror, 'notes/a.md')

    expect(mirror.docIdForPath('notes/a.md')).toBe(a.id)
    expect(mirror.pathForDocId(a.id)).toBe('notes/a.md')
    expect(mirror.docIdForPath('nope.md')).toBeNull()
    expect(mirror.pathForDocId('nope')).toBeNull()
    expect(mirror.knownPaths()).toContain('notes/a.md')
    expect(mirror.bridgeForPath('nope.md')).toBeNull()
  })

  it('reports turn activity up and back down across a foreign write', async () => {
    const a = meta('live.md')
    const seed = new SimClient(URL, a.id)
    seed.text.insert(0, 'v1\n')
    cleanups.push(async () => seed.destroy())
    const { mirror, root, activity } = await makeMirror(fakeApi([a]))
    await mirror.start()
    await waitForBridge(mirror, 'live.md')
    await waitUntil(async () => (await readFile(join(root, 'live.md'), 'utf8').catch(() => null)) === 'v1\n')

    await writeFile(join(root, 'live.md'), 'v1\nagent\n', 'utf8')
    await waitUntil(() => activity.includes(1), 8000, 'turn opened')
    await waitUntil(() => activity.at(-1) === 0, 8000, 'turn closed')
    expect(mirror.docIdForPath('live.md')).toBe(a.id)
  })

  it('endOpenTurns() ends every active turn (the Stop hook carries no path)', async () => {
    const a = meta('stop.md')
    const seed = new SimClient(URL, a.id)
    seed.text.insert(0, 'base\n')
    cleanups.push(async () => seed.destroy())
    // idle would take a minute — only endOpenTurns can close this turn in-test
    const fake = fakeApi([a])
    const dir = await mkdtemp(join(tmpdir(), 'holi-vma-'))
    const root = join(dir, 'work')
    const activity: number[] = []
    const mirror = new VaultMirror({
      vaultId: VAULT,
      workRoot: root,
      baseDir: join(dir, 'bases'),
      relayUrl: URL,
      token: 'tok',
      api: fake.api,
      turnIdleMs: 60_000,
      lifecycleDebounceMs: 150,
      onTurnActivity: (n) => activity.push(n),
    })
    cleanups.push(async () => {
      await mirror.stop()
      await rm(dir, { recursive: true, force: true })
    })
    await mirror.start()
    await waitForBridge(mirror, 'stop.md')
    await waitUntil(async () => (await readFile(join(root, 'stop.md'), 'utf8').catch(() => null)) === 'base\n')

    await writeFile(join(root, 'stop.md'), 'base\nagent line\n', 'utf8')
    await waitUntil(() => activity.at(-1) === 1, 8000, 'turn opened')

    mirror.endOpenTurns()
    await waitUntil(() => activity.at(-1) === 0, 8000, 'turn ended by endOpenTurns')
    await waitUntil(() => seed.toString() === 'base\nagent line\n', 8000, 'merged into the CRDT')
  })

  it('onMaterialize fires when a remote edit rewrites the file', async () => {
    const a = meta('mat.md')
    const human = new SimClient(URL, a.id)
    human.text.insert(0, 'v1\n')
    cleanups.push(async () => human.destroy())
    const { mirror, root, materialized } = await makeMirror(fakeApi([a]))
    await mirror.start()
    await waitForBridge(mirror, 'mat.md')
    await waitUntil(async () => (await readFile(join(root, 'mat.md'), 'utf8').catch(() => null)) === 'v1\n')
    // the initial materialization already fired the callback — assert on growth
    const before = materialized.length
    expect(materialized).toContain('mat.md')

    human.text.insert(0, 'v2 ')
    await waitUntil(() => materialized.length > before, 8000, 'remote edit re-materialized')
    expect(materialized.at(-1)).toBe('mat.md')
  })
})
