import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { jsonFileStore } from '../src/main/json-file-store'

let dir: string
let path: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-json-store-'))
  path = join(dir, 'nested', 'prefs.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const record = (raw: unknown): Record<string, number> =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.fromEntries(
        Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === 'number'),
      )
    : {}

describe('jsonFileStore', () => {
  it('reads a missing or corrupt file as parse(null)', async () => {
    const store = jsonFileStore(path, record)
    expect(await store.read()).toEqual({})
    await store.update((c) => ({ ...c, a: 1 }))
    await writeFile(path, '{ not json')
    expect(await store.read()).toEqual({})
  })

  it('writes readable JSON with a trailing newline', async () => {
    await jsonFileStore(path, record).update(() => ({ a: 1 }))
    expect(await readFile(path, 'utf8')).toBe('{\n  "a": 1\n}\n')
  })

  // The race every one of these stores had: two changes at once each read the
  // file, and the second rename dropped the first's change.
  it('applies concurrent updates one after another, losing none', async () => {
    const store = jsonFileStore(path, record)
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.update((c) => ({ ...c, [`k${i}`]: i }))),
    )
    expect(Object.keys(await store.read())).toHaveLength(20)
  })

  it('keeps going after a change that throws', async () => {
    const store = jsonFileStore(path, record)
    await expect(
      store.update(() => {
        throw new Error('no')
      }),
    ).rejects.toThrow('no')
    await store.update((c) => ({ ...c, a: 1 }))
    expect(await store.read()).toEqual({ a: 1 })
  })

  it('sees a hand edit, unless it caches', async () => {
    const live = jsonFileStore(path, record)
    const cached = jsonFileStore(path, record, { cache: true })
    await live.update(() => ({ a: 1 }))
    expect(await cached.read()).toEqual({ a: 1 })
    await writeFile(path, '{"a": 2}')
    expect(await live.read()).toEqual({ a: 2 })
    expect(await cached.read()).toEqual({ a: 1 })
  })
})
