/**
 * What the agent is told the person looks at: the focused note, the lines
 * selected in it once the selection holds still, and nothing of another
 * note's selection or of the vault before.
 */
import { createStore } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { workspaceAtom } from '../panes'
import { editorSelectionAtom, reportUiToMain } from '../ui-report'
import { activeRemoteAtom } from '../vaults'

const report = vi.hoisted(() => vi.fn())
vi.mock('../../lib/trpc', () => ({
  trpc: { ui: { report: { mutate: (input: unknown) => report(input) } } },
}))

beforeEach(() => {
  vi.useFakeTimers()
  report.mockReset()
  report.mockResolvedValue({ ok: true })
})
afterEach(() => vi.useRealTimers())

function setup() {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(workspaceAtom, {
    panes: [{ tabs: [{ kind: 'note', path: 'notes/plan.md' }], active: 0 }],
    active: 0,
  })
  const off = reportUiToMain(store)
  return { store, off }
}

const last = () =>
  report.mock.calls.at(-1)![0] as { focusedPath: string | null; selection: unknown }

test('the focused note carries its selected lines once they hold still', async () => {
  const { store, off } = setup()
  await vi.advanceTimersByTimeAsync(0)
  expect(last()).toMatchObject({ focusedPath: 'notes/plan.md', selection: null })
  store.set(editorSelectionAtom, { path: 'notes/plan.md', lines: { startLine: 3, endLine: 5 } })
  await vi.advanceTimersByTimeAsync(100)
  expect(last().selection).toBeNull()
  await vi.advanceTimersByTimeAsync(300)
  expect(last().selection).toEqual({ startLine: 3, endLine: 5 })
  off()
})

test("another note's selection is not the focused one's, and a vault switch clears it", async () => {
  const { store, off } = setup()
  store.set(editorSelectionAtom, { path: 'notes/other.md', lines: { startLine: 1, endLine: 2 } })
  await vi.advanceTimersByTimeAsync(400)
  expect(last().selection).toBeNull()
  store.set(editorSelectionAtom, { path: 'notes/plan.md', lines: { startLine: 1, endLine: 2 } })
  store.set(activeRemoteAtom, 'syv/other')
  await vi.advanceTimersByTimeAsync(400)
  expect(store.get(editorSelectionAtom)).toBeNull()
  off()
})
