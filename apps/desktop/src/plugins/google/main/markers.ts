import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { jsonFileStore, type JsonFileStore } from '../../../main/plugin-api'

const MAIL_MARKERS = ['yellow-star', 'red-star', 'blue-question'] as const
export type MailMarker = (typeof MAIL_MARKERS)[number]
export type MarkerValue = MailMarker | null

type MarkerFile = {
  version: 1
  accountSub: string
  threads: Record<string, MailMarker>
}

export interface MailMarkerStore {
  read(threadIds: readonly string[]): Promise<Record<string, MarkerValue>>
  set(threadId: string, marker: MarkerValue): Promise<void>
  /** Orders Gmail mutations across data handles for this account and thread. */
  runExclusive<T>(threadId: string, work: () => Promise<T>): Promise<T>
  purge(): Promise<void>
}

const MAX_BATCH = 100
const THREAD_ID = /^[A-Za-z0-9_-]{1,256}$/
const ACCOUNT_SUB = /^[A-Za-z0-9_-]{1,256}$/

/** Per-account durable annotations. A malformed file is an error, never an empty store. */
export function createMailMarkerStore(userData: string, accountSub: string): MailMarkerStore {
  if (!ACCOUNT_SUB.test(accountSub)) throw new Error('invalid Google account id')
  const path = join(userData, `google-mail-markers-${accountSub}.json`)
  const store: JsonFileStore<MarkerFile> = jsonFileStore(path, (raw, text) => {
    if (text === null) return { version: 1, accountSub, threads: {} }
    if (
      !isRecord(raw) ||
      raw.version !== 1 ||
      raw.accountSub !== accountSub ||
      !isRecord(raw.threads)
    )
      throw new Error('Google mail marker data is invalid; it was not changed')
    const threads: Record<string, MailMarker> = {}
    for (const [id, marker] of Object.entries(raw.threads)) {
      if (!THREAD_ID.test(id) || !isMailMarker(marker))
        throw new Error('Google mail marker data is invalid; it was not changed')
      threads[id] = marker
    }
    return { version: 1, accountSub, threads }
  })

  let retired = false
  const queues = new Map<string, Promise<unknown>>()
  const serialize = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const result = (queues.get(key) ?? Promise.resolve()).then(work, work)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    queues.set(key, tail)
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key)
    })
    return result
  }
  const assertActive = () => {
    if (retired) throw new Error('that Google account is no longer connected')
  }

  return {
    async read(threadIds) {
      validateBatch(threadIds)
      assertActive()
      return serialize('store', async () => {
        assertActive()
        const file = await store.read()
        assertActive()
        return Object.fromEntries(threadIds.map((id) => [id, file.threads[id] ?? null]))
      })
    },
    async set(threadId, marker) {
      validateThreadId(threadId)
      if (marker !== null && !isMailMarker(marker)) throw new Error('invalid mail marker')
      assertActive()
      return serialize('store', async () => {
        assertActive()
        await store.update((current) => {
          assertActive()
          const threads = { ...current.threads }
          if (marker === null) delete threads[threadId]
          else threads[threadId] = marker
          return { version: 1, accountSub, threads }
        })
        assertActive()
      })
    },
    runExclusive(threadId, work) {
      validateThreadId(threadId)
      return serialize(threadId, async () => {
        assertActive()
        const result = await work()
        assertActive()
        return result
      })
    },
    async purge() {
      retired = true
      return serialize('store', async () => {
        await rm(path, { force: true })
      })
    },
  }
}

function validateThreadId(id: string): void {
  if (typeof id !== 'string' || !THREAD_ID.test(id)) throw new Error('invalid Gmail thread id')
}

export function validateBatch(ids: readonly string[]): void {
  if (!Array.isArray(ids) || ids.length > MAX_BATCH) throw new Error('invalid mail marker batch')
  const seen = new Set<string>()
  for (const id of ids) {
    validateThreadId(id)
    if (seen.has(id)) throw new Error('duplicate Gmail thread id')
    seen.add(id)
  }
}

export function isMailMarker(value: unknown): value is MailMarker {
  return typeof value === 'string' && (MAIL_MARKERS as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
