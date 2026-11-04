/**
 * A document tab says Updated when its text changed while another tab was in
 * front, and only then: not for a new file time alone (the save on leaving,
 * the commit's tidy), and not once it is looked at again.
 */
import { act, renderHook, waitFor } from '@/test/render'
import { emptyVaultSnapshot } from '@holi/shared'
import { createStore, Provider } from 'jotai'
import type { ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { changedDocsAtom, docTabs, sawText, useDocChangeMarks } from '../doc-changes'
import { shellWorkspaceAtom } from '../shell-tabs'
import { emptyWorkspace, openTab, selectEntry } from '../shell-workspace'
import { activeRemoteAtom, snapshotAtom } from '../vaults'

const read = vi.fn<(input: { remote: string; path: string }) => Promise<string>>()

vi.mock('@/lib/trpc', () => ({
  trpc: { notes: { read: { query: (input: { remote: string; path: string }) => read(input) } } },
}))

const REMOTE = 'syv-ai/notes'
const PLAN = 'Planning/Q4.md'
const OTHER = 'notes/a.md'

afterEach(() => read.mockReset())

function setup() {
  const store = createStore()
  store.set(activeRemoteAtom, REMOTE)
  // Both open, the plan behind the other.
  store.set(shellWorkspaceAtom, openTab(openTab(emptyWorkspace(), PLAN), OTHER))
  const at = (time: string) =>
    store.set(snapshotAtom, {
      ...emptyVaultSnapshot(),
      docs: [
        { path: PLAN, kind: 'note', updatedAt: time },
        { path: OTHER, kind: 'note', updatedAt: '2026-10-25T10:00:00Z' },
      ],
    })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  renderHook(() => useDocChangeMarks(), { wrapper })
  return { store, at }
}

test('the documents open in tabs, and those in front', () => {
  const ws = openTab(openTab(emptyWorkspace(), PLAN), OTHER)
  expect(docTabs(ws)).toEqual({ open: new Set([PLAN, OTHER]), showing: new Set([OTHER]) })
})

test('a hidden document whose text changed says Updated until it is shown', async () => {
  sawText(REMOTE, PLAN, '# Q4\n\nShip it.\n')
  const { store, at } = setup()
  read.mockResolvedValue('# Q4\n\nShip it.\n\nAnd the agent added this.\n')
  act(() => at('2026-10-25T10:05:00Z'))
  await waitFor(() => expect(store.get(changedDocsAtom)).toEqual(new Set([PLAN])))
  act(() => store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, PLAN)))
  expect(store.get(changedDocsAtom).size).toBe(0)
})

test('a new time with the same text, or only the tidy, is not a change', async () => {
  // What the tab left with: a stray space, no final newline. The commit's
  // tidy dropped one and added the other.
  sawText(REMOTE, PLAN, '# Q4 \n\nShip it.')
  const { store, at } = setup()
  read.mockResolvedValue('# Q4\n\nShip it.\n')
  act(() => at('2026-10-25T10:06:00Z'))
  await waitFor(() => expect(read).toHaveBeenCalled())
  await act(async () => {})
  expect(store.get(changedDocsAtom).size).toBe(0)
})
