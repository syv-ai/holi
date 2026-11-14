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
  read(
    threadIds: readonly string[],
    validate?: () => Promise<void>,
  ): Promise<Record<string, MarkerValue>>
  set(threadId: string, marker: MarkerValue, validate?: () => Promise<void>): Promise<void>
  /** Orders Gmail mutations across data handles for this account and thread. */
  runExclusive<T>(threadId: string, work: () => Promise<T>): Promise<T>
  purge(): Promise<void>
}

const MAX_BATCH = 100
const THREAD_ID = /^[A-Za-z0-9_-]{1,256}$/
export const validateThreadId = (id: string): void => {
  if (typeof id !== 'string' || !THREAD_ID.test(id)) throw new Error('invalid Gmail thread id')
}
const ACCOUNT_SUB = /^[A-Za-z0-9_-]{1,256}$/
const lifecycleQueues = new Map<string, Promise<unknown>>()

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
    const threads: Record<string, MailMarker> = Object.create(null)
    for (const [id, marker] of Object.entries(raw.threads)) {
      if (!THREAD_ID.test(id) || !isMailMarker(marker))
        throw new Error('Google mail marker data is invalid; it was not changed')
      Object.defineProperty(threads, id, {
        value: marker,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return { version: 1, accountSub, threads }
  })

  let retired = false
  const serialize = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const queueKey = `${path}:${key}`
    const result = (lifecycleQueues.get(queueKey) ?? Promise.resolve()).then(work, work)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    lifecycleQueues.set(queueKey, tail)
    void tail.then(() => {
      if (lifecycleQueues.get(queueKey) === tail) lifecycleQueues.delete(queueKey)
    })
    return result
  }
  const assertActive = () => {
    if (retired) throw new Error('that Google account is no longer connected')
  }

  return {
    async read(threadIds, validate) {
      validateBatch(threadIds)
      assertActive()
      return serialize('store', async () => {
        assertActive()
        await validate?.()
        const file = await store.read()
        assertActive()
        await validate?.()
        return Object.fromEntries(
          threadIds.map((id) => [id, Object.hasOwn(file.threads, id) ? file.threads[id]! : null]),
        )
      })
    },
    async set(threadId, marker, validate) {
      validateThreadId(threadId)
      if (marker !== null && !isMailMarker(marker)) throw new Error('invalid mail marker')
      assertActive()
      return serialize('store', async () => {
        assertActive()
        await validate?.()
        await store.update(async (current) => {
          assertActive()
          await validate?.()
          assertActive()
          const threads = { ...current.threads }
          if (marker === null) delete threads[threadId]
          else
            Object.defineProperty(threads, threadId, {
              value: marker,
              enumerable: true,
              writable: true,
              configurable: true,
            })
          return { version: 1, accountSub, threads }
        })
        assertActive()
        await validate?.()
      })
    },
    runExclusive(threadId, work) {
      validateThreadId(threadId)
      return serialize(`thread:${threadId}`, async () => {
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
