/**
 * What the agent is told the person looks at: the focused note, the lines
 * selected in it once the selection holds still, and nothing of another
 * note's selection or of the vault before. In a split, typing to the agent
 * keeps the note beside it.
 */
import { createStore } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { shellWorkspaceAtom } from '../shell-tabs'
import type { ShellEntry } from '../shell-workspace'
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
  show(store, ['notes/plan.md'], 'notes/plan.md')
  const off = reportUiToMain(store)
  return { store, off }
}

/** The strip as `entries`, with `active` in front. */
function show(store: ReturnType<typeof createStore>, entries: ShellEntry[], active: string) {
  store.set(shellWorkspaceAtom, { entries, active, closed: [], seq: 1 })
}

const split = (views: string[], focused: string): ShellEntry => ({
  id: 'holi:split:1',
  views,
  shares: views.map(() => 1 / views.length),
  focused,
})

const SESSION = 'holi:session:agent:s1'

const last = () =>
  report.mock.calls.at(-1)![0] as {
    focusedPath: string | null
    selection: unknown
    openPaths: string[]
  }

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

test('typing to the agent in a split keeps the note beside it, with its selection', async () => {
  const { store, off } = setup()
  show(store, ['notes/plan.md', split([SESSION, 'specs/api.md'], SESSION)], 'holi:split:1')
  store.set(editorSelectionAtom, { path: 'specs/api.md', lines: { startLine: 4, endLine: 9 } })
  await vi.advanceTimersByTimeAsync(400)
  expect(last()).toMatchObject({
    focusedPath: 'specs/api.md',
    selection: { startLine: 4, endLine: 9 },
  })
  off()
})

test('of two notes beside the agent, the one last focused there', async () => {
  const { store, off } = setup()
  const views = ['a.md', 'b.md', SESSION]
  show(store, [split(views, 'b.md')], 'holi:split:1')
  await vi.advanceTimersByTimeAsync(0)
  show(store, [split(views, SESSION)], 'holi:split:1')
  await vi.advanceTimersByTimeAsync(0)
  expect(last().focusedPath).toBe('b.md')
  show(store, [split(views, 'a.md')], 'holi:split:1')
  await vi.advanceTimersByTimeAsync(0)
  show(store, [split(views, SESSION)], 'holi:split:1')
  await vi.advanceTimersByTimeAsync(0)
  expect(last().focusedPath).toBe('a.md')
  off()
})

test('an agent tab of its own keeps the note before it; another view reports none', async () => {
  const { store, off } = setup()
  await vi.advanceTimersByTimeAsync(0)
  show(store, ['notes/plan.md', SESSION], SESSION)
  await vi.advanceTimersByTimeAsync(0)
  expect(last().focusedPath).toBe('notes/plan.md')
  show(store, ['notes/plan.md', SESSION, 'holi:board'], 'holi:board')
  await vi.advanceTimersByTimeAsync(0)
  expect(last().focusedPath).toBeNull()
  off()
})

test('open notes are counted once, across tabs and splits', async () => {
  const { store, off } = setup()
  show(store, ['notes/plan.md', split(['a.md', 'holi:graph'], 'a.md')], 'notes/plan.md')
  await vi.advanceTimersByTimeAsync(0)
  expect(last().openPaths).toEqual(['notes/plan.md', 'a.md'])
  off()
})
