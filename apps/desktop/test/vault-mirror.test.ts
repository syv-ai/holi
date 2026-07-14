import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Hocuspocus } from '@hocuspocus/server'
import type { DocMeta } from '@holi/shared'
import { VaultMirror, type MirrorApi, type VaultMirrorDeps } from '../src/main/vault/vault-mirror'
import { SimClient, sleep, startRelay, waitUntil } from './helpers/relay'

const PORT = 5612
const URL = `ws://127.0.0.1:${PORT}`
const VAULT = 'v-1'

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
  created: string[]
  deleted: string[]
  snapshots: string[]
}

function fakeApi(docs: DocMeta[]): Fake {
  const fake: Fake = {
    docs,
    created: [],
    deleted: [],
    snapshots: [],
    api: {
      listDocs: async () => [...fake.docs],
      createNote: async (path) => {
        const m = meta(path)
        fake.docs.push(m)
        fake.created.push(path)
        return m
      },
      deleteNote: async (docId) => {
        fake.docs = fake.docs.filter((d) => d.id !== docId)
        fake.deleted.push(docId)
      },
      takeSnapshot: async (docId) => void fake.snapshots.push(docId),
    },
  }
  return fake
}

/** Seed a relay room with content the way the server would serve it. */
function seedRoom(docId: string, text: string): SimClient {
  const c = new SimClient(URL, docId)
  if (text) c.text.insert(0, text)
  return c
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function makeMirror(
  fake: Fake,
  extra: Partial<VaultMirrorDeps> = {},
): Promise<{ mirror: VaultMirror; root: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-vm-'))
  const root = join(dir, 'work')
  const mirror = new VaultMirror({
    vaultId: VAULT,
    workRoot: root,
    baseDir: join(dir, 'bases'),
    relayUrl: URL,
    token: 'tok',
    api: fake.api,
    turnIdleMs: 200,
    lifecycleDebounceMs: 150,
    ...extra,
  })
  cleanups.push(async () => {
    await mirror.stop()
    await rm(dir, { recursive: true, force: true })
  })
  return { mirror, root }
}

// chokidar/provider timing legitimately takes seconds on loaded machines; the
// waitUntil allowances (8s) must bind before the per-test cap, not after
describe('VaultMirror', { timeout: 15_000 }, () => {
  it('materializes every listed doc on start, including .claude content', async () => {
    const a = meta('notes/a.md')
    const b = meta('.claude/settings.json')
    const ca = seedRoom(a.id, '# A\n')
    const cb = seedRoom(b.id, '{}\n')
    cleanups.push(async () => (ca.destroy(), cb.destroy()))
    const fake = fakeApi([a, b])
    const { mirror, root } = await makeMirror(fake)
    await mirror.start()
    await waitUntil(async () => (await readFile(join(root, 'notes/a.md'), 'utf8').catch(() => null)) === '# A\n')
    await waitUntil(async () => (await readFile(join(root, '.claude/settings.json'), 'utf8').catch(() => null)) === '{}\n')
  })

  it('a remote edit re-materializes the file', async () => {
    const a = meta('live.md')
    const human = seedRoom(a.id, 'v1\n')
    cleanups.push(async () => human.destroy())
    const { mirror, root } = await makeMirror(fakeApi([a]))
    await mirror.start()
    await waitUntil(async () => (await readFile(join(root, 'live.md'), 'utf8').catch(() => null)) === 'v1\n')
    human.text.insert(0, 'v2 ')
    await waitUntil(async () => (await readFile(join(root, 'live.md'), 'utf8').catch(() => null)) === 'v2 v1\n')
  })

  it('docs events: created materializes, renamed moves, deleted removes', async () => {
    const { mirror, root } = await makeMirror(fakeApi([]))
    await mirror.start()

    const c = meta('new.md')
    const seed = seedRoom(c.id, 'fresh\n')
    cleanups.push(async () => seed.destroy())
    mirror.handleDocsEvent({ type: 'created', doc: c })
    await waitUntil(async () => (await readFile(join(root, 'new.md'), 'utf8').catch(() => null)) === 'fresh\n')

    mirror.handleDocsEvent({ type: 'renamed', doc: { ...c, path: 'moved/new.md' } })
    await waitUntil(async () => (await readFile(join(root, 'moved/new.md'), 'utf8').catch(() => null)) === 'fresh\n')

    mirror.handleDocsEvent({ type: 'deleted', doc: { ...c, path: 'moved/new.md' } })
    await waitUntil(async () => (await readFile(join(root, 'moved/new.md'), 'utf8').catch(() => null)) === null)
  })

  it('agent-created file becomes a doc with its content (git-ingress symmetry)', async () => {
    const fake = fakeApi([])
    const { mirror, root } = await makeMirror(fake)
    await mirror.start()
    await mkdir(join(root, 'notes'), { recursive: true })
    await writeFile(join(root, 'notes/idea.md'), 'agent wrote this\n', 'utf8')
    await waitUntil(() => fake.created.includes('notes/idea.md'), 8000, 'createNote called')
    const created = fake.docs.find((d) => d.path === 'notes/idea.md')!
    const observer = new SimClient(URL, created.id)
    cleanups.push(async () => observer.destroy())
    await waitUntil(() => observer.toString() === 'agent wrote this\n', 8000, 'content synced')
  })

  it('local-only and junk files are never adopted', async () => {
    const fake = fakeApi([])
    const { mirror, root } = await makeMirror(fake)
    await mirror.start()
    await writeFile(join(root, 'USER.md'), 'personal\n', 'utf8')
    await mkdir(join(root, '.holi'), { recursive: true })
    await writeFile(join(root, '.holi/settings.local.json'), '{}\n', 'utf8')
    await writeFile(join(root, '.DS_Store'), 'junk', 'utf8')
    await sleep(600) // > lifecycleDebounceMs — nothing should happen
    expect(fake.created).toEqual([])
  })

  it('task files are never adopted as docs — they are records, not CRDT docs', async () => {
    // Without this exclusion the agent writing tasks/foo.md turns it into a CRDT
    // note, and a server-driven rewrite (a recurrence roll landing the instant
    // the agent marks something done) arrives as a foreign write that opens a
    // spurious turn — mid-turn. The mirror must see task files and do nothing.
    const fake = fakeApi([])
    const taskEvents: Array<{ kind: string; rel: string }> = []
    const { mirror, root } = await makeMirror(fake, {
      onTaskFileEvent: (kind, rel) => void taskEvents.push({ kind, rel }),
    })
    await mirror.start()

    await mkdir(join(root, 'tasks'), { recursive: true })
    const rel = 'tasks/review-the-q2-doc-aaaaaaaa-1111-4111-8111-111111111111.md'
    await writeFile(join(root, rel), '---\ntitle: Review\n---\n\nBody.\n', 'utf8')

    // the projector still hears about it — it just is not the doc machinery's business
    await waitUntil(() => taskEvents.some((e) => e.rel === rel), 8000, 'projector notified')
    await sleep(600) // > lifecycleDebounceMs — adoption would have fired by now

    expect(fake.created).toEqual([]) // no notes.create
    expect(fake.snapshots).toEqual([]) // no pre-turn snapshot
    expect(mirror.docIdForPath(rel)).toBeNull() // no doc
    expect(mirror.bridgeForPath(rel)).toBeNull() // no bridge, so no base/turn/merge
    expect(mirror.knownPaths()).not.toContain(rel)
  })

  it('a task file deleted on disk reaches the projector, not notes.delete', async () => {
    const fake = fakeApi([])
    const taskEvents: Array<{ kind: string; rel: string }> = []
    const { mirror, root } = await makeMirror(fake, {
      onTaskFileEvent: (kind, rel) => void taskEvents.push({ kind, rel }),
    })
    await mirror.start()

    await mkdir(join(root, 'tasks'), { recursive: true })
    const rel = 'tasks/gone-bbbbbbbb-2222-4222-8222-222222222222.md'
    await writeFile(join(root, rel), '---\ntitle: Gone\n---\n', 'utf8')
    await waitUntil(() => taskEvents.some((e) => e.kind !== 'unlink'), 8000, 'add seen')
    await unlink(join(root, rel))

    await waitUntil(() => taskEvents.some((e) => e.kind === 'unlink'), 8000, 'unlink seen')
    expect(fake.deleted).toEqual([]) // rm on a task file is a task delete, not a doc delete
  })

  it('agent rm deletes the doc server-side', async () => {
    const a = meta('kill-me.md')
    const seed = seedRoom(a.id, 'bye\n')
    cleanups.push(async () => seed.destroy())
    const fake = fakeApi([a])
    const { mirror, root } = await makeMirror(fake)
    await mirror.start()
    await waitUntil(async () => (await readFile(join(root, 'kill-me.md'), 'utf8').catch(() => null)) === 'bye\n')
    await unlink(join(root, 'kill-me.md'))
    await waitUntil(() => fake.deleted.includes(a.id), 8000, 'deleteNote called')
  })

  it('agent edit runs a turn: snapshot taken, awareness flagged, human concurrent edit survives', async () => {
    const a = meta('shared.md')
    const human = seedRoom(a.id, 'alpha\nomega\n')
    cleanups.push(async () => human.destroy())
    const fake = fakeApi([a])
    const { mirror, root } = await makeMirror(fake)
    await mirror.start()
    const file = join(root, 'shared.md')
    await waitUntil(async () => (await readFile(file, 'utf8').catch(() => null)) === 'alpha\nomega\n')

    const awareness: unknown[] = []
    human.provider.awareness!.on('change', () => {
      for (const [, state] of human.provider.awareness!.getStates()) {
        if ('agentEditing' in (state as Record<string, unknown>)) awareness.push((state as Record<string, unknown>).agentEditing)
      }
    })

    await writeFile(file, 'alpha\nomega (agent)\n', 'utf8')
    human.insertAfter('alpha', ' (human)')
    await waitUntil(() => human.toString() === 'alpha (human)\nomega (agent)\n', 8000, 'merged')
    await waitUntil(async () => (await readFile(file, 'utf8')) === 'alpha (human)\nomega (agent)\n', 8000, 'file remat')
    expect(fake.snapshots).toEqual([a.id])
    expect(awareness).toContain(true)
  })

  it('startup scan adopts unknown files already on disk', async () => {
    const fake = fakeApi([])
    const dir = await mkdtemp(join(tmpdir(), 'holi-vm-'))
    const root = join(dir, 'work')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'leftover.md'), 'crash orphan\n', 'utf8')
    const mirror = new VaultMirror({
      vaultId: VAULT,
      workRoot: root,
      baseDir: join(dir, 'bases'),
      relayUrl: URL,
      token: 'tok',
      api: fake.api,
      turnIdleMs: 200,
      lifecycleDebounceMs: 150,
    })
    cleanups.push(async () => {
      await mirror.stop()
      await rm(dir, { recursive: true, force: true })
    })
    await mirror.start()
    await waitUntil(() => fake.created.includes('leftover.md'), 8000, 'adopted at startup')
  })
})
