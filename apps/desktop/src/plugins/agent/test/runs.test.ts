/** Run-change loaders consume bounded-history failures and never leave rejected promises. */
import { createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import { runFilesAtom, loadRunChangesAtom } from '../renderer/state/runs'

const turns = vi.fn()
const files = vi.fn()
vi.mock('../renderer/agent-cap', () => ({
  agentCap: {
    turns: (...args: unknown[]) => turns(...args),
    turnFiles: (...args: unknown[]) => files(...args),
  },
}))

const remote = 'git@github.com:syv-ai/runs.git'

beforeEach(() => {
  turns.mockReset()
  files.mockReset()
  turns.mockResolvedValue([
    { base: 'a'.repeat(40), end: 'b'.repeat(40), at: '2026-01-01T00:00:00Z', sessionId: 'job' },
  ])
  files.mockRejectedValue(new Error('historical read exceeded its time limit'))
})

test('consumes the run file failure and settles the run file state', async () => {
  const store = createStore()
  store.set(activeRemoteAtom, remote)
  await expect(store.set(loadRunChangesAtom, ['job'])).resolves.toBeUndefined()
  expect(store.get(runFilesAtom)).toEqual({ job: [] })
})

test('does not apply an in-flight result after the vault changes', async () => {
  const store = createStore()
  store.set(activeRemoteAtom, remote)
  let release!: (value: never[]) => void
  files.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
  const pending = store.set(loadRunChangesAtom, ['job'])
  await Promise.resolve()
  store.set(activeRemoteAtom, 'git@github.com:syv-ai/other.git')
  release([])
  await pending
  expect(store.get(runFilesAtom)).toEqual({})
})
