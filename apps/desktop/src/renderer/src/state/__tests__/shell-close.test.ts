import { afterEach, expect, test, vi } from 'vitest'
import { createStore } from 'jotai'
import { registerBuffer } from '@/lib/buffer-registry'
import { saveEntryClose, type EntryCloseIntent } from '../shell-close'
import { shellWorkspaceAtom } from '../shell-tabs'
import { emptyWorkspace, openInSplit, openNewTab, openTab } from '../shell-workspace'
import { activeRemoteAtom } from '../vaults'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
})

function splitIntent() {
  const store = createStore()
  const remote = 'demo/first'
  const workspace = openInSplit(openTab(emptyWorkspace(), 'Plan.md'), 'Ideas.md')
  store.set(activeRemoteAtom, remote)
  store.set(shellWorkspaceAtom, workspace)
  const intent: EntryCloseIntent = {
    remote,
    workspace,
    request: { kind: 'entry', id: workspace.active! },
  }
  return { store, intent }
}

function pendingBuffer() {
  let finish!: () => void
  const flush = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
  const freeze = vi.fn()
  cleanups.push(registerBuffer(flush, flush, freeze))
  return { flush, freeze, finish: () => finish() }
}

test('confirmed closure waits for buffers to save and keeps the split in closed history', async () => {
  const { store, intent } = splitIntent()
  const buffer = pendingBuffer()
  const closing = saveEntryClose(store, intent)
  expect(buffer.flush).toHaveBeenCalledOnce()
  expect(buffer.freeze).toHaveBeenLastCalledWith(true)
  expect(store.get(shellWorkspaceAtom)).toBe(intent.workspace)
  buffer.finish()
  await closing
  expect(store.get(shellWorkspaceAtom).entries).toEqual([])
  expect(store.get(shellWorkspaceAtom).closed).toEqual([
    { views: ['Plan.md', 'Ideas.md'], shares: [0.5, 0.5] },
  ])
  expect(buffer.freeze).toHaveBeenLastCalledWith(false)
})

test('a failed save leaves the approved workspace intact and unfreezes its buffers', async () => {
  const { store, intent } = splitIntent()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const flush = vi.fn().mockRejectedValue(new Error('disk is full'))
  const freeze = vi.fn()
  cleanups.push(registerBuffer(flush, flush, freeze))
  await saveEntryClose(store, intent)
  expect(store.get(shellWorkspaceAtom)).toBe(intent.workspace)
  expect(error).toHaveBeenCalled()
  expect(freeze).toHaveBeenLastCalledWith(false)
})

test('a workspace changed while saving cannot be closed by an earlier confirmation', async () => {
  const { store, intent } = splitIntent()
  const buffer = pendingBuffer()
  const closing = saveEntryClose(store, intent)
  const changed = openNewTab(intent.workspace)
  store.set(shellWorkspaceAtom, changed)
  buffer.finish()
  await closing
  expect(store.get(shellWorkspaceAtom)).toBe(changed)
})

test('switching vaults while saving closes neither vault workspace', async () => {
  const { store, intent } = splitIntent()
  const buffer = pendingBuffer()
  const closing = saveEntryClose(store, intent)
  store.set(activeRemoteAtom, 'demo/second')
  const second = openTab(emptyWorkspace(), 'Other.md')
  store.set(shellWorkspaceAtom, second)
  buffer.finish()
  await closing
  expect(store.get(shellWorkspaceAtom)).toBe(second)
  store.set(activeRemoteAtom, intent.remote)
  expect(store.get(shellWorkspaceAtom)).toBe(intent.workspace)
})

test('an already stale confirmation does not start saving or change the workspace', async () => {
  const { store, intent } = splitIntent()
  const flush = vi.fn(async () => {})
  cleanups.push(registerBuffer(flush))
  const changed = openNewTab(intent.workspace)
  store.set(shellWorkspaceAtom, changed)
  await saveEntryClose(store, intent)
  expect(flush).not.toHaveBeenCalled()
  expect(store.get(shellWorkspaceAtom)).toBe(changed)
})
