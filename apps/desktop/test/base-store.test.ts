import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BaseStore } from '../src/main/vault/base-store'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

describe('BaseStore', () => {
  it('round-trips text + binary state and removes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-bs-'))
    dirs.push(dir)
    const store = new BaseStore(dir)
    const state = new Uint8Array([0, 1, 2, 255, 128])
    await store.save('doc-1', { text: 'hello Ø\n', state })
    const loaded = await store.load('doc-1')
    expect(loaded!.text).toBe('hello Ø\n')
    expect([...loaded!.state]).toEqual([0, 1, 2, 255, 128])
    await store.remove('doc-1')
    expect(await store.load('doc-1')).toBeNull()
  })

  it('load returns null for unknown docs and survives a second save (overwrite)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-bs-'))
    dirs.push(dir)
    const store = new BaseStore(dir)
    expect(await store.load('nope')).toBeNull()
    await store.save('d', { text: 'v1', state: new Uint8Array([1]) })
    await store.save('d', { text: 'v2', state: new Uint8Array([2]) })
    expect((await store.load('d'))!.text).toBe('v2')
  })
})
