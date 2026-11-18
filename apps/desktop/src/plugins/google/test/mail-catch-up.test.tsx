import { createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom, activeRemoteRevisionValueAtom } from '@/plugin-api'
import {
  beginMailCatchUp,
  confirmMailCatchUpCleanup,
  finishMailCatchUp,
  mailCatchUpByVaultAtom,
} from '../renderer/mail/mail-catch-up'

const { stop } = vi.hoisted(() => ({ stop: vi.fn() }))
vi.mock('@/lib/trpc', () => ({
  trpc: { cap: { run: { mutate: stop } } },
}))

beforeEach(() => stop.mockReset().mockResolvedValue({ ok: true }))

const remote = 'syv-ai/vault'
function setup() {
  const store = createStore()
  store.set(activeRemoteAtom, remote)
  const id = beginMailCatchUp(store, remote)!
  return { store, id }
}

test('a clean failure survives reads and is explicitly consumed by retry; old promises cannot replace the retry', () => {
  const { store, id } = setup()
  const revision = store.get(activeRemoteRevisionValueAtom)
  finishMailCatchUp(store, remote, id, { kind: 'failed', revision, error: 'try again' })
  expect(store.get(mailCatchUpByVaultAtom).get(remote)).toMatchObject({
    kind: 'failed',
    error: 'try again',
  })
  const retry = beginMailCatchUp(store, remote)!
  expect(retry).not.toBe(id)
  finishMailCatchUp(store, remote, id, { kind: 'done' })
  finishMailCatchUp(store, remote, id, { kind: 'failed', revision, error: 'stale' })
  expect(store.get(mailCatchUpByVaultAtom).get(remote)).toMatchObject({
    kind: 'pending',
    id: retry,
  })
  finishMailCatchUp(store, remote, retry, { kind: 'done' })
  expect(store.get(mailCatchUpByVaultAtom).has(remote)).toBe(false)
})

test('cleanup is single-flight and consumes only the matching known admission', async () => {
  const { store, id } = setup()
  finishMailCatchUp(store, remote, id, {
    kind: 'uncertain',
    sessionId: 'owned',
    error: 'uncertain',
  })
  let resolve!: (value: { ok: true }) => void
  stop.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const confirming = confirmMailCatchUpCleanup(store, remote, id, () => true)
  await confirmMailCatchUpCleanup(store, remote, id, () => true)
  expect(stop).toHaveBeenCalledTimes(1)
  expect(stop).toHaveBeenCalledWith({
    remote,
    name: 'agent.stop',
    paramsJson: JSON.stringify({ id: 'owned' }),
  })
  expect(beginMailCatchUp(store, remote)).toBeNull()
  resolve({ ok: true })
  await confirming
  expect(store.get(mailCatchUpByVaultAtom).has(remote)).toBe(false)
})

test('an old confirmation cannot clear a replacement admission in the same vault', async () => {
  const { store, id } = setup()
  finishMailCatchUp(store, remote, id, {
    kind: 'uncertain',
    sessionId: 'owned',
    error: 'uncertain',
  })
  let resolve!: (value: { ok: true }) => void
  stop.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const confirming = confirmMailCatchUpCleanup(store, remote, id, () => true)
  store.set(mailCatchUpByVaultAtom, new Map())
  const replacement = beginMailCatchUp(store, remote)
  resolve({ ok: true })
  await confirming
  expect(store.get(mailCatchUpByVaultAtom).get(remote)).toMatchObject({
    kind: 'pending',
    id: replacement,
  })
})

test('unknown ownership never calls stop or becomes retryable', async () => {
  const { store, id } = setup()
  finishMailCatchUp(store, remote, id, {
    kind: 'uncertain',
    sessionId: null,
    error: 'identify native ownership',
  })
  await confirmMailCatchUpCleanup(store, remote, id, () => true)
  expect(stop).not.toHaveBeenCalled()
  expect(beginMailCatchUp(store, remote)).toBeNull()
})
