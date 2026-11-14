import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonFileStore } from '../src/main/json-file-store'

const readBarrier = vi.hoisted(() => ({
  path: null as string | null,
  entered: null as (() => void) | null,
  wait: null as Promise<void> | null,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === readBarrier.path) {
        readBarrier.path = null
        const result = await actual.readFile(...args)
        readBarrier.entered?.()
        await readBarrier.wait
        return result
      }
      return actual.readFile(...args)
    },
  }
})

let dir: string
let path: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-json-store-'))
  path = join(dir, 'nested', 'prefs.json')
})
afterEach(async () => {
  readBarrier.path = null
  readBarrier.entered = null
  readBarrier.wait = null
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

  it('does not overwrite a file it cannot read', async () => {
    await mkdir(path, { recursive: true })
    const store = jsonFileStore(path, record)
    await expect(store.read()).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(store.update(() => ({ a: 1 }))).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'EISDIR' })
    await rm(path, { recursive: true })
    await store.update(() => ({ recovered: 1 }))
    expect(await store.read()).toEqual({ recovered: 1 })
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

  it('keeps going after a change or write throws', async () => {
    const store = jsonFileStore(path, record)
    await expect(
      store.update(() => {
        throw new Error('no')
      }),
    ).rejects.toThrow('no')
    await expect(
      store.update(() => {
        const circular: Record<string, unknown> = {}
        circular.self = circular
        return circular as Record<string, number>
      }),
    ).rejects.toThrow()
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

  it('orders updates from separate handles and preserves both entries', async () => {
    const left = jsonFileStore(path, record)
    const right = jsonFileStore(path, record)
    let release!: () => void
    let entered!: () => void
    const enteredFirst = new Promise<void>((resolve) => (entered = resolve))
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const first = left.update(async (current) => {
      entered()
      await blocked
      return { ...current, first: 1 }
    })
    await enteredFirst
    let secondEntered = false
    const second = right.update((current) => {
      secondEntered = true
      return { ...current, second: 2 }
    })
    await Promise.resolve()
    expect(secondEntered).toBe(false)
    release()
    await Promise.all([first, second])
    expect(await readFile(path, 'utf8')).toContain('"first": 1')
    expect(await readFile(path, 'utf8')).toContain('"second": 2')
  })

  it('coordinates normalized aliases and invalidates another handle cache', async () => {
    const cached = jsonFileStore(path, record, { cache: true })
    const alias = jsonFileStore(`${dir}/nested/./prefs.json`, record)
    await cached.update(() => ({ initial: 0 }))
    expect(await cached.read()).toEqual({ initial: 0 })
    await alias.update((current) => ({ ...current, remote: 1 }))
    expect(await cached.read()).toEqual({ initial: 0, remote: 1 })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ initial: 0, remote: 1 })
  })

  it('keeps parsed caches local to each handle', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(path, '{"value": 3}')
    const numberValue = jsonFileStore(path, (raw) => (raw as { value: number }).value, {
      cache: true,
    })
    const stringValue = jsonFileStore(path, (raw) => String((raw as { value: number }).value), {
      cache: true,
    })
    expect(await numberValue.read()).toBe(3)
    expect(await stringValue.read()).toBe('3')
    expect(await stringValue.read()).toBe('3')
  })

  it('does not cache a slow read that overlaps a completed write', async () => {
    const cached = jsonFileStore(path, record, { cache: true })
    const writer = jsonFileStore(path, record)
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(path, '{"before": 1}')
    let release!: () => void
    let entered!: () => void
    const enteredRead = new Promise<void>((resolve) => (entered = resolve))
    readBarrier.path = path
    readBarrier.entered = entered
    readBarrier.wait = new Promise<void>((resolve) => (release = resolve))
    const slowRead = cached.read()
    await enteredRead
    await writer.update((current) => ({ ...current, after: 2 }))
    release()
    expect(await slowRead).toEqual({ before: 1 })
    expect(await cached.read()).toEqual({ before: 1, after: 2 })
    readBarrier.entered = null
    readBarrier.wait = null
  })

  it('keeps different files independent while one change is blocked', async () => {
    const otherPath = join(dir, 'other.json')
    const blockedStore = jsonFileStore(path, record)
    const independent = jsonFileStore(otherPath, record)
    let release!: () => void
    let entered!: () => void
    const enteredChange = new Promise<void>((resolve) => (entered = resolve))
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const pending = blockedStore.update(async () => {
      entered()
      await blocked
      return { blocked: 1 }
    })
    await enteredChange
    await expect(independent.update(() => ({ independent: 1 }))).resolves.toEqual({
      independent: 1,
    })
    expect(JSON.parse(await readFile(otherPath, 'utf8'))).toEqual({ independent: 1 })
    release()
    await pending
  })
})
