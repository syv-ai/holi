import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import { DocStore } from '../src/main/vault/doc-store'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function store(): Promise<DocStore> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-ds-'))
  dirs.push(dir)
  return new DocStore(dir)
}

/** The store that makes an offline edit survive a quit (D59). */
describe('DocStore', () => {
  // The point of the whole store: a real Yjs state, not a byte array, has to come back
  // as a doc with the same content — that is what "your edit survived" means.
  it('round-trips a real Yjs state into a working doc', async () => {
    const s = await store()
    const doc = new Y.Doc()
    doc.getText(YDOC_TEXT_KEY).insert(0, 'an edit made offline')
    await s.save('doc-1', Y.encodeStateAsUpdate(doc))

    const restored = new Y.Doc()
    Y.applyUpdate(restored, (await s.load('doc-1'))!)
    expect(restored.getText(YDOC_TEXT_KEY).toString()).toBe('an edit made offline')
  })

  it('keeps binary bytes intact through the base64 round-trip', async () => {
    const s = await store()
    const state = new Uint8Array([0, 1, 2, 255, 128, 0])
    await s.save('doc-1', state)
    expect([...(await s.load('doc-1'))!]).toEqual([0, 1, 2, 255, 128, 0])
  })

  it('is null for a doc it has never seen', async () => {
    expect(await (await store()).load('nope')).toBeNull()
  })

  // An unreadable local cache must degrade to "sync from the relay", never take the vault
  // down. `load` is called on every openEntry, so a throw here would fail activation for
  // the whole vault over one corrupt file.
  it('is null — never a throw — on a corrupt file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-ds-'))
    dirs.push(dir)
    const s = new DocStore(dir)
    await writeFile(join(dir, 'doc-1.json'), 'not json at all', 'utf8')
    expect(await s.load('doc-1')).toBeNull()
  })

  it('is null on well-formed JSON that is not a state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-ds-'))
    dirs.push(dir)
    const s = new DocStore(dir)
    await writeFile(join(dir, 'doc-1.json'), JSON.stringify({ nope: true }), 'utf8')
    expect(await s.load('doc-1')).toBeNull()
  })

  it('overwrites in place, so the newest state wins', async () => {
    const s = await store()
    const doc = new Y.Doc()
    doc.getText(YDOC_TEXT_KEY).insert(0, 'first')
    await s.save('doc-1', Y.encodeStateAsUpdate(doc))
    doc.getText(YDOC_TEXT_KEY).insert(5, ' then second')
    await s.save('doc-1', Y.encodeStateAsUpdate(doc))

    const restored = new Y.Doc()
    Y.applyUpdate(restored, (await s.load('doc-1'))!)
    expect(restored.getText(YDOC_TEXT_KEY).toString()).toBe('first then second')
  })

  it('removes', async () => {
    const s = await store()
    await s.save('doc-1', new Uint8Array([1]))
    await s.remove('doc-1')
    expect(await s.load('doc-1')).toBeNull()
  })

  it('removing a doc it never had is not an error', async () => {
    await expect((await store()).remove('nope')).resolves.toBeUndefined()
  })
})
