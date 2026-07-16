import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Hocuspocus } from '@hocuspocus/server'
import { YDOC_TEXT_KEY, type DocMeta } from '@holi/shared'
import { VaultMirror, type MirrorApi } from '../src/main/vault/vault-mirror'
import { SimClient, startRelay, waitUntil } from './helpers/relay'

/**
 * Offline (D59) — the gap that destroyed user work.
 *
 * Notes were memory-only: an edit made offline never reached the relay, so it never
 * reached main's mirror, so it never reached disk, and it died on quit. These tests are
 * the property itself, not its parts — a mirror is stood up, torn down, and stood back up
 * against a **dead relay** over the same userData dirs, which is what "quit and relaunch
 * on a plane" actually is.
 *
 * DEAD_URL points at a port nothing listens on. That is the fixture: not a mock of being
 * offline, but actually being offline.
 */
const PORT = 5613
const URL = `ws://127.0.0.1:${PORT}`
const DEAD_URL = 'ws://127.0.0.1:5699'
const VAULT = 'v-off'

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
  deleted: string[]
  listDocsFails: boolean
}

function fakeApi(docs: DocMeta[]): Fake {
  const fake: Fake = {
    docs,
    deleted: [],
    listDocsFails: false,
    api: {
      listDocs: async () => {
        if (fake.listDocsFails) throw new Error('fetch failed: server unreachable')
        return [...fake.docs]
      },
      createNote: async (path) => {
        const m = meta(path)
        fake.docs.push(m)
        return m
      },
      deleteNote: async (docId) => void fake.deleted.push(docId),
      takeSnapshot: async () => {},
    },
  }
  return fake
}

const cleanups: Array<() => Promise<void>> = []
// LIFO: the temp dir is registered before the mirrors that live in it, so unwinding in
// insertion order would delete the directory out from under a mirror still writing to it.
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** One machine's userData: several mirrors over the SAME dirs, like relaunching. */
async function machine() {
  const dir = await mkdtemp(join(tmpdir(), 'holi-off-'))
  cleanups.push(async () => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'work')

  const boot = async (fake: Fake, relayUrl: string): Promise<VaultMirror> => {
    const mirror = new VaultMirror({
      vaultId: VAULT,
      workRoot: root,
      baseDir: join(dir, 'bases'),
      docStateDir: join(dir, 'docstate'),
      relayUrl,
      token: 'tok',
      api: fake.api,
      turnIdleMs: 200,
      lifecycleDebounceMs: 150,
      persistDebounceMs: 50,
      log: () => {},
    })
    await mirror.start()
    return mirror
  }
  return { dir, root, boot }
}

const read = (p: string) => readFile(p, 'utf8').catch(() => null)

describe('offline (D59)', { timeout: 20_000 }, () => {
  // THE acceptance property of the whole plan: edit, quit, relaunch with no server, and
  // the edit is still there. Before this, it was gone.
  it('an edit survives a quit and comes back with no relay at all', async () => {
    const a = meta('plane.md')
    const room = new SimClient(URL, a.id)
    cleanups.push(async () => room.destroy())
    room.text.insert(0, 'written before the flight\n')

    const fake = fakeApi([a])
    const { root, boot } = await machine()
    const file = join(root, 'plane.md')

    const online = await boot(fake, URL)
    await waitUntil(async () => (await read(file)) === 'written before the flight\n', 8000, 'first materialize')

    // Edit it the way the agent (or the editor, through main) does, and let it merge.
    await writeFile(file, 'written before the flight\nedited at 30,000 feet\n', 'utf8')
    await waitUntil(
      () => room.toString() === 'written before the flight\nedited at 30,000 feet\n',
      8000,
      'the edit to merge',
    )
    await online.stop() // quit

    // Relaunch with no server and no relay.
    fake.listDocsFails = true
    const offline = await boot(fake, DEAD_URL)
    cleanups.push(async () => offline.stop())

    // NOT `read(file)` — the working copy is already on disk from the online session, so
    // asserting on it passes whether or not the doc ever opened, and proves nothing.
    // (Mutation testing caught exactly that: "always await synced" survived a file-based
    // assertion.) `bridgeForPath` answers only for a STARTED entry, and with no relay an
    // entry can only start from persisted state — so this is the real property.
    await waitUntil(
      () => offline.bridgeForPath('plane.md') !== null,
      8000,
      'the doc to start with no relay',
    )

    // ...and the doc main actually holds carries the offline edit, which is what the
    // editor would bind to.
    const bound = offline.linkRenderer(a.id, { sendUpdate: () => {}, sendAwareness: () => {} })
    expect(bound).not.toBeNull()
    const restored = new Y.Doc()
    Y.applyUpdate(restored, bound!.link.stateAsUpdate())
    expect(restored.getText(YDOC_TEXT_KEY).toString()).toContain('edited at 30,000 feet')
    expect(await read(file)).toContain('edited at 30,000 feet')
  })

  // The most dangerous line in the change. `refresh()` closes every entry absent from
  // listDocs and DELETES its working copy. A cached list is not evidence that anything
  // was deleted — wire the fallback into that half and an offline launch destroys the
  // user's notes. Deleting a note is exactly what offline must never do.
  it('a failed listDocs never deletes a working copy', async () => {
    const a = meta('precious.md')
    const room = new SimClient(URL, a.id)
    cleanups.push(async () => room.destroy())
    room.text.insert(0, 'do not lose me\n')

    const fake = fakeApi([a])
    const { root, boot } = await machine()
    const file = join(root, 'precious.md')

    const online = await boot(fake, URL)
    await waitUntil(async () => (await read(file)) === 'do not lose me\n', 8000, 'materialize')
    await online.stop()

    fake.listDocsFails = true
    const offline = await boot(fake, DEAD_URL)
    cleanups.push(async () => offline.stop())
    await new Promise((r) => setTimeout(r, 800)) // let any (wrong) reconcile run

    expect(await read(file)).toBe('do not lose me\n')
    expect(fake.deleted).toEqual([]) // and nothing was deleted server-side either
  })

  // The offline path must open docs, never close them — but the ONLINE path still has to
  // close them, or a note deleted by a teammate lives forever. A positive control for the
  // test above: same assertion, opposite expectation, so "never deletes" cannot pass by
  // the delete path being broken outright.
  it('still deletes a working copy when the server really says the doc is gone', async () => {
    const a = meta('doomed.md')
    const room = new SimClient(URL, a.id)
    cleanups.push(async () => room.destroy())
    room.text.insert(0, 'here for now\n')

    const fake = fakeApi([a])
    const { root, boot } = await machine()
    const file = join(root, 'doomed.md')

    const mirror = await boot(fake, URL)
    cleanups.push(async () => mirror.stop())
    await waitUntil(async () => (await read(file)) === 'here for now\n', 8000, 'materialize')

    fake.docs = [] // the server now says: that doc does not exist
    await mirror.refresh()
    expect(await read(file)).toBeNull()
  })

  // No cache AND no server is a genuinely different case: nothing to open and no basis to
  // guess. It must fail the way it always did rather than silently present an empty vault.
  it('a first-ever launch with no server and no cache still fails', async () => {
    const fake = fakeApi([meta('never-seen.md')])
    fake.listDocsFails = true
    const { boot } = await machine()
    await expect(boot(fake, DEAD_URL)).rejects.toThrow(/unreachable/)
  })

  /**
   * Persisting is deliberately skipped mid-turn (the doc is a transient merge against a
   * frozen base, and the fs work perturbs awareness delivery exactly when presence
   * matters), so the turn's END has to schedule the write it deferred.
   *
   * Asserted WITHOUT stopping the mirror, and that is the whole point: `closeEntry`
   * persists too, so any test that quits first passes even if the turn-end persist never
   * fires. Mutation testing caught precisely that.
   */
  it('persists the merged result when a turn ends, with no quit involved', async () => {
    const a = meta('turn.md')
    const room = new SimClient(URL, a.id)
    cleanups.push(async () => room.destroy())
    room.text.insert(0, 'before\n')

    const fake = fakeApi([a])
    const { dir, root, boot } = await machine()
    const mirror = await boot(fake, URL)
    cleanups.push(async () => mirror.stop())
    const file = join(root, 'turn.md')
    await waitUntil(async () => (await read(file)) === 'before\n', 8000, 'materialize')

    await writeFile(file, 'before\nthe agent wrote this\n', 'utf8')
    await waitUntil(() => room.toString().includes('the agent wrote this'), 8000, 'the turn to merge')

    const stateFile = join(dir, 'docstate', `${a.id}.json`)
    await waitUntil(
      async () => {
        const raw = await read(stateFile)
        if (!raw) return false
        const doc = new Y.Doc()
        Y.applyUpdate(doc, new Uint8Array(Buffer.from(JSON.parse(raw).stateB64, 'base64')))
        return doc.getText(YDOC_TEXT_KEY).toString().includes('the agent wrote this')
      },
      8000,
      'the turn-end persist to write the merged result',
    )
  })

  // The quit path. before-quit does not await teardown, so whatever the debounce is
  // holding is exactly the edit the user just made.
  it('flushPersist writes state the debounce is still holding', async () => {
    const a = meta('flush.md')
    const room = new SimClient(URL, a.id)
    cleanups.push(async () => room.destroy())
    room.text.insert(0, 'unflushed\n')

    const fake = fakeApi([a])
    const { dir, root, boot } = await machine()
    const mirror = await boot(fake, URL)
    cleanups.push(async () => mirror.stop())
    await waitUntil(async () => (await read(join(root, 'flush.md'))) === 'unflushed\n', 8000, 'materialize')

    await mirror.flushPersist()
    const persisted = await read(join(dir, 'docstate', `${a.id}.json`))
    expect(persisted).not.toBeNull()
  })
})
