import { Provider, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@/test/render'
import { TabStrip } from '../tab-strip'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { closeTab, combineOnStrip, emptyWorkspace, openTab } from '@/state/shell-workspace'
import { activeRemoteAtom } from '@/state/vaults'
import { tabDragAtom, tabDragVaultAtom, tabDragWasOpenAtom } from '../use-tab-drag'

vi.mock('@/lib/trpc', () => {
  const procedure = {
    query: async () => null,
    mutate: async () => ({ ok: true }),
    subscribe: () => ({ unsubscribe() {} }),
  }
  const router = () => new Proxy({}, { get: () => procedure })
  return { trpc: new Proxy({}, { get: () => router() }) }
})

const MIME = 'application/x-holi-tab'
function setup(workspace = openTab(openTab(emptyWorkspace(), 'A.md'), 'B.md')) {
  const store = createStore()
  store.set(activeRemoteAtom, 'owner/vault')
  store.set(shellWorkspaceAtom, workspace)
  render(
    <Provider store={store}>
      <TabStrip onNewTab={() => {}} />
    </Provider>,
  )
  const list = document.querySelector<HTMLElement>('[role="tablist"]')!
  const tabs = Array.from(list.querySelectorAll<HTMLElement>('[data-entry-id]'))
  for (const [index, tab] of tabs.entries()) {
    vi.spyOn(tab, 'getBoundingClientRect').mockReturnValue({
      left: index * 100,
      right: (index + 1) * 100,
      width: 100,
      top: 0,
      bottom: 36,
      height: 36,
      x: index * 100,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)
  }
  const data = new Map<string, string>([[MIME, 'A.md']])
  const transfer = {
    types: [MIME],
    getData: (type: string) => data.get(type) ?? '',
    setData: (type: string, value: string) => data.set(type, value),
    dropEffect: 'none',
    effectAllowed: 'all',
  } as unknown as DataTransfer
  act(() => {
    store.set(tabDragAtom, 'A.md')
    store.set(tabDragVaultAtom, 'owner/vault')
    store.set(tabDragWasOpenAtom, true)
  })
  return { store, list, tabs, transfer }
}
function dragEvent(type: 'dragover' | 'drop', transfer: DataTransfer, x: number) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, { clientX: { value: x }, dataTransfer: { value: transfer } })
  return event
}

test('ordinary target hover renders the prospective target-first split without mutating workspace', () => {
  const { store, list, tabs, transfer } = setup()
  const before = store.get(shellWorkspaceAtom)
  fireEvent(list, dragEvent('dragover', transfer, 150))
  expect(screen.getByRole('tab', { name: 'Split view: B, A' })).toBeTruthy()
  expect(store.get(shellWorkspaceAtom)).toBe(before)
  expect(tabs[1]!.dataset.combinePreview).toBe('true')
})

test('combine preview keeps the hovered title connected so leaving clears it', () => {
  const { list, tabs, transfer } = setup()
  const title = screen.getByText('B')
  expect(title.parentElement?.classList.contains('flex')).toBe(true)
  fireEvent(list, dragEvent('dragover', transfer, 150))
  expect(title.isConnected).toBe(true)
  expect(title.closest('.opacity-0')).not.toBeNull()
  expect(tabs[1]!.dataset.combinePreview).toBe('true')

  const leave = new Event('dragleave', { bubbles: true })
  Object.defineProperty(leave, 'relatedTarget', { value: document.body })
  fireEvent(title, leave)
  expect(tabs[1]!.dataset.combinePreview).toBeUndefined()
})

test('split preview retains its hovered member and hides original labels until leaving', () => {
  const workspace = combineOnStrip(
    openTab(openTab(openTab(emptyWorkspace(), 'A.md'), 'B.md'), 'C.md'),
    'C.md',
    'B.md',
  )
  const { store, list, tabs, transfer } = setup(workspace)
  const before = store.get(shellWorkspaceAtom)
  const title = screen.getByText('B')
  fireEvent(list, dragEvent('dragover', transfer, 150))
  expect(title.isConnected).toBe(true)
  expect(title.closest('.opacity-0')).not.toBeNull()
  expect(title.closest('.invisible')).toBeNull()
  expect(tabs[1]!.dataset.combinePreview).toBe('true')
  expect(store.get(shellWorkspaceAtom)).toBe(before)

  const leave = new Event('dragleave', { bubbles: true })
  Object.defineProperty(leave, 'relatedTarget', { value: document.body })
  fireEvent(title, leave)
  expect(tabs[1]!.dataset.combinePreview).toBeUndefined()
  expect(title.closest('.opacity-0')).toBeNull()
})

test('combine preview preserves measured target geometry through repeated hover and drop', () => {
  const { store, list, transfer } = setup()
  const items = Array.from(list.querySelectorAll<HTMLElement>('[data-entry-id]'))
  for (const [index, item] of items.entries()) {
    vi.spyOn(item, 'getBoundingClientRect').mockImplementation(() => {
      const widths = items.map((candidate) => {
        const trigger = candidate.querySelector('[role="tab"]')!
        return trigger.className.includes('w-80')
          ? 320
          : trigger.className.includes('w-64')
            ? 256
            : 224
      })
      const left = widths.slice(0, index).reduce((sum, width) => sum + width, 0)
      const width = widths[index]!
      return {
        left,
        right: left + width,
        width,
        top: 0,
        bottom: 36,
        height: 36,
        x: left,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect
    })
  }
  const targetCenterBoundary = 224 + 60
  fireEvent(list, dragEvent('dragover', transfer, targetCenterBoundary))
  expect(items[1]!.dataset.combinePreview).toBe('true')
  expect(items[1]!.querySelector('[role="tab"]')!.className).toContain('w-56')
  fireEvent(list, dragEvent('dragover', transfer, targetCenterBoundary))
  expect(items[1]!.dataset.combinePreview).toBe('true')
  fireEvent(list, dragEvent('drop', transfer, targetCenterBoundary))
  expect(store.get(shellWorkspaceAtom).entries).toHaveLength(1)
  expect(store.get(shellWorkspaceAtom).entries[0]).toMatchObject({ views: ['B.md', 'A.md'] })
})

test('a closed original source cannot be reopened by an edge drop', () => {
  const { store, list, tabs, transfer } = setup()
  fireEvent(list, dragEvent('dragover', transfer, 150))
  expect(tabs[1]!.dataset.combinePreview).toBe('true')
  act(() => store.set(shellWorkspaceAtom, (workspace) => closeTab(workspace, 'A.md')))
  const afterClose = store.get(shellWorkspaceAtom)
  expect(afterClose.entries).toEqual(['B.md'])
  fireEvent(list, dragEvent('drop', transfer, 5))
  expect(store.get(shellWorkspaceAtom)).toBe(afterClose)
  expect(store.get(shellWorkspaceAtom).entries).toEqual(['B.md'])
  expect(document.querySelector('[data-combine-preview="true"]')).toBeNull()
  expect(document.querySelector('[data-drop-before="true"], [data-drop-after="true"]')).toBeNull()
})

test('closing an originally open drag source cancels global drag state without dragend', () => {
  const { store } = setup()
  act(() => store.set(shellWorkspaceAtom, (workspace) => closeTab(workspace, 'A.md')))
  expect(store.get(tabDragAtom)).toBeNull()
  expect(store.get(tabDragVaultAtom)).toBeNull()
  expect(store.get(tabDragWasOpenAtom)).toBe(false)

  // The native source was removed with the tab, so no dragend can arrive later.
  act(() => store.set(shellWorkspaceAtom, (workspace) => openTab(workspace, 'A.md')))
  expect(store.get(tabDragAtom)).toBeNull()
})

test('changing vault ownership cancels the drag before returning to its source vault', () => {
  const { store, list, transfer } = setup()
  fireEvent(list, dragEvent('dragover', transfer, 150))
  expect(document.querySelector('[data-combine-preview="true"]')).not.toBeNull()

  act(() => store.set(activeRemoteAtom, 'other/vault'))
  expect(store.get(tabDragAtom)).toBeNull()
  expect(store.get(tabDragVaultAtom)).toBeNull()
  expect(store.get(tabDragWasOpenAtom)).toBe(false)
  act(() => store.set(activeRemoteAtom, 'owner/vault'))
  expect(document.querySelector('[data-combine-preview="true"]')).toBeNull()
  fireEvent(list, dragEvent('dragover', transfer, 150))
  expect(document.querySelector('[data-combine-preview="true"]')).toBeNull()
})

test('an unopened sidebar view is accepted for a same-vault combine preview', () => {
  const { store, list, transfer } = setup()
  const unopened = 'C.md'
  transfer.setData(MIME, unopened)
  act(() => {
    store.set(tabDragAtom, unopened)
    store.set(tabDragWasOpenAtom, false)
  })
  fireEvent(list, dragEvent('dragover', transfer, 150))
  expect(document.querySelector('[data-combine-preview="true"]')).not.toBeNull()
  expect(screen.getByRole('tab', { name: 'Split view: B, C' })).toBeTruthy()
  expect(store.get(tabDragWasOpenAtom)).toBe(false)
})

test('dropping a valid ordinary target combines once and clears drag state', () => {
  const { store, list, transfer } = setup()
  fireEvent(list, dragEvent('dragover', transfer, 150))
  fireEvent(list, dragEvent('drop', transfer, 150))
  expect(store.get(shellWorkspaceAtom).entries).toHaveLength(1)
  expect(store.get(shellWorkspaceAtom).entries[0]).toMatchObject({ views: ['B.md', 'A.md'] })
  expect(store.get(tabDragAtom)).toBeNull()
  expect(store.get(tabDragVaultAtom)).toBeNull()
})

test('Escape cancels the preview and leaves tabs unchanged', () => {
  const { store, list, tabs, transfer } = setup()
  fireEvent(list, dragEvent('dragover', transfer, 150))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(tabs[1]!.dataset.combinePreview).toBeUndefined()
  expect(store.get(shellWorkspaceAtom).entries).toEqual(['A.md', 'B.md'])
})

test.each(['end', 'vault change'])(
  'a drag %s clears the reorder marker without mutation',
  (reason) => {
    const { store, list, tabs, transfer } = setup()
    const before = store.get(shellWorkspaceAtom)
    fireEvent(list, dragEvent('dragover', transfer, 195))
    expect(tabs[1]!.dataset.dropAfter).toBe('true')
    act(() => {
      if (reason === 'end') store.set(tabDragAtom, null)
      else store.set(tabDragVaultAtom, 'other/vault')
    })
    expect(document.querySelector('[data-drop-before="true"], [data-drop-after="true"]')).toBeNull()
    expect(store.get(shellWorkspaceAtom)).toBe(before)
  },
)

test('a cross-vault drag is rejected without mutation', () => {
  const { store, list, transfer } = setup()
  act(() => store.set(tabDragVaultAtom, 'other/vault'))
  fireEvent(list, dragEvent('dragover', transfer, 150))
  expect(store.get(shellWorkspaceAtom).entries).toEqual(['A.md', 'B.md'])
  expect(document.querySelector('[data-combine-preview="true"]')).toBeNull()
})

test('leaving the strip cancels its preview and a later drop cannot combine', () => {
  const { store, list, tabs, transfer } = setup()
  fireEvent(list, dragEvent('dragover', transfer, 150))
  const leave = new Event('dragleave', { bubbles: true })
  Object.defineProperty(leave, 'relatedTarget', { value: document.body })
  fireEvent(tabs[1]!, leave)
  expect(tabs[1]!.dataset.combinePreview).toBeUndefined()
  fireEvent(list, dragEvent('drop', transfer, 150))
  expect(store.get(shellWorkspaceAtom).entries).toEqual(['A.md', 'B.md'])
})
