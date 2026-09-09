/**
 * The agent turn under review (D88, toward #4).
 *
 * A turn is a commit range, so everything here is a question asked of git at the
 * moment it is asked. What that leaves worth testing is the ordering: a turn
 * whose range has gone, a file selected while another is still in flight, and a
 * vault switched underneath a panel that is still showing the last one's turn.
 */
import { createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import {
  latestTurnAtom,
  loadLatestTurnAtom,
  loadTurnDiffAtom,
  loadTurnFilesAtom,
  resetTurnReviewAtom,
  revertFileAtom,
  selectedTurnPathAtom,
  turnDiffAtom,
  turnFilesAtom,
} from '../turns'
import { activeRemoteAtom } from '../vaults'

const list = vi.fn()
const files = vi.fn()
const fileDiff = vi.fn()
const revert = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    turns: {
      list: { query: () => list() },
      files: { query: (i: unknown) => files(i) },
      fileDiff: { query: (i: unknown) => fileDiff(i) },
      revert: { mutate: (i: unknown) => revert(i) },
    },
  },
}))

const flushAllBuffers = vi.fn(() => Promise.resolve())
vi.mock('@/lib/buffer-registry', () => ({ flushAllBuffers: () => flushAllBuffers() }))

const TURN = { base: 'aaa', end: 'bbb', at: '2026-09-09T10:00:00Z' }
const REMOTE = 'git@github.com:syv-ai/vault.git'

beforeEach(() => {
  for (const fn of [list, files, fileDiff, revert, flushAllBuffers]) fn.mockReset()
  flushAllBuffers.mockResolvedValue(undefined)
  list.mockResolvedValue([TURN])
  files.mockResolvedValue([{ path: 'a.md', status: 'M', added: 2, removed: 1 }])
  fileDiff.mockResolvedValue({ before: 'old\n', after: 'new\n' })
  revert.mockResolvedValue({ ok: true })
})

function store() {
  const s = createStore()
  s.set(activeRemoteAtom, REMOTE)
  return s
}

test('takes the newest turn, which is the one worth reviewing', async () => {
  const s = store()
  list.mockResolvedValue([TURN, { base: 'x', end: 'y', at: '2026-09-08T10:00:00Z' }])
  await s.set(loadLatestTurnAtom)
  expect(s.get(latestTurnAtom)).toEqual(TURN)
})

test('leaves the latest turn null for a vault that has never run one', async () => {
  const s = store()
  list.mockResolvedValue([])
  await s.set(loadLatestTurnAtom)
  expect(s.get(latestTurnAtom)).toBeNull()
})

test('lists what the turn changed', async () => {
  const s = store()
  await s.set(loadLatestTurnAtom)
  await s.set(loadTurnFilesAtom)
  expect(files).toHaveBeenCalledWith({ base: 'aaa', end: 'bbb' })
  expect(s.get(turnFilesAtom)).toHaveLength(1)
})

test('asks nothing when there is no turn to ask about', async () => {
  const s = store()
  await s.set(loadTurnFilesAtom)
  expect(files).not.toHaveBeenCalled()
  expect(s.get(turnFilesAtom)).toEqual([])
})

test('an unreachable range is an empty file list, not a throw', async () => {
  // A turn record outlives the commits it names. The panel says so; it must not
  // be handed an error.
  const s = store()
  files.mockResolvedValue([])
  await s.set(loadLatestTurnAtom)
  await s.set(loadTurnFilesAtom)
  expect(s.get(turnFilesAtom)).toEqual([])
})

test('loads the diff for the file that was picked', async () => {
  const s = store()
  await s.set(loadLatestTurnAtom)
  await s.set(loadTurnDiffAtom, 'a.md')
  expect(fileDiff).toHaveBeenCalledWith({ base: 'aaa', end: 'bbb', path: 'a.md' })
  expect(s.get(selectedTurnPathAtom)).toBe('a.md')
  expect(s.get(turnDiffAtom)).toEqual({ before: 'old\n', after: 'new\n' })
})

test('does not stamp one file’s diff over another’s', async () => {
  // Two rows clicked in quick succession: the slower answer must not win.
  const s = store()
  await s.set(loadLatestTurnAtom)
  let releaseSlow: (v: unknown) => void = () => {}
  fileDiff.mockImplementationOnce(() => new Promise((r) => (releaseSlow = r)))
  const slow = s.set(loadTurnDiffAtom, 'slow.md')
  fileDiff.mockResolvedValue({ before: '', after: 'fast\n' })
  await s.set(loadTurnDiffAtom, 'fast.md')
  releaseSlow({ before: '', after: 'slow\n' })
  await slow
  expect(s.get(selectedTurnPathAtom)).toBe('fast.md')
  expect(s.get(turnDiffAtom)).toEqual({ before: '', after: 'fast\n' })
})

test('reverting writes the resolved text and re-asks what is left', async () => {
  const s = store()
  await s.set(loadLatestTurnAtom)
  await s.set(loadTurnFilesAtom)
  files.mockClear()
  await s.set(revertFileAtom, { path: 'a.md', text: 'mine\n' })
  expect(revert).toHaveBeenCalledWith({ remote: REMOTE, path: 'a.md', text: 'mine\n' })
  // The revert just made a commit of its own, so the range's file list is stale
  // at the one moment it is being looked at.
  expect(files).toHaveBeenCalled()
})

test('reverting does nothing without a vault', async () => {
  const s = createStore()
  await s.set(revertFileAtom, { path: 'a.md', text: 'mine\n' })
  expect(revert).not.toHaveBeenCalled()
})

test('a reset clears the last turn off the screen', async () => {
  // Switching vault must not leave the previous one's turn under review.
  const s = store()
  await s.set(loadLatestTurnAtom)
  await s.set(loadTurnFilesAtom)
  await s.set(loadTurnDiffAtom, 'a.md')
  s.set(resetTurnReviewAtom)
  expect(s.get(latestTurnAtom)).toBeNull()
  expect(s.get(turnFilesAtom)).toEqual([])
  expect(s.get(selectedTurnPathAtom)).toBeNull()
  expect(s.get(turnDiffAtom)).toBeNull()
})

test('does not flush the open buffer before reverting', () => {
  // Where this parts company with History's Restore. Restore replaces a file
  // with an older version, so the current state is being discarded on purpose
  // and a flush plus a clean reload is coherent. A turn revert takes back what
  // the AGENT did; the reader's own unsaved edits are not part of that, and
  // flushing would write them to disk only to overwrite them with the resolved
  // text. Left alone, `decideReload` 3-way merges them instead.
  expect(flushAllBuffers).not.toHaveBeenCalled()
})
