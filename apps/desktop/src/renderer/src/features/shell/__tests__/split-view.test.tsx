/**
 * Split tabs in the shell (docs/features/tabs-panes.md): one strip in the
 * title band holds every tab, a split view being one pill of it; ⌘\\, a
 * tab's menu and a drag make a split; its members carry thin headers.
 */
import { act } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { afterEach, expect, test, vi } from 'vitest'
import {
  VAULT_SETTING_DEFAULTS,
  emptyVaultSnapshot,
  type ResolvedVaultSettings,
} from '@holi/shared'

import { createEvent, fireEvent, render, screen, waitFor, within } from '@/test/render'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { activeSplit, focusedTab, isSplit, openTab, splitActive } from '@/state/shell-workspace'
import { vaultSettingsAtom } from '@/state/settings'
import { tabDragAtom } from '@/features/shell/use-tab-drag'
import { registerBuffer } from '@/lib/buffer-registry'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '@/state/vaults'

const write = vi.fn(async (_input: unknown) => ({
  ok: true as const,
  warnings: [] as string[],
}))

const bufferCleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of bufferCleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
})

const SETTINGS: ResolvedVaultSettings = {
  ...VAULT_SETTING_DEFAULTS,
  warnings: [],
}

// Every other call the shell makes answers nothing, and never rejects. Two
// levels deep, `trpc.<router>.<procedure>`, and nothing for a symbol, so
// nothing walking the mock can recurse forever.
vi.mock('@/lib/trpc', () => {
  const answer = (name: string): unknown =>
    name === 'settings.read'
      ? SETTINGS
      : name === 'settings.pluginFailures'
        ? {}
        : name === 'github.collaborators'
          ? { visibility: 'private', collaborators: [] }
          : null
  const procedure = (name: string) => ({
    query: async () => answer(name),
    mutate: name === 'settings.write' ? write : async () => ({ ok: true }),
    subscribe: () => ({ unsubscribe() {} }),
  })
  const router = (routerName: string) =>
    new Proxy(
      {},
      {
        get: (_t, key) => (typeof key === 'string' ? procedure(`${routerName}.${key}`) : undefined),
      },
    )
  const trpc = new Proxy(
    {},
    { get: (_t, key) => (typeof key === 'string' ? router(key) : undefined) },
  )
  return { trpc }
})

// jsdom lays nothing out, and the resizable panels answer a zero width with
// a resize, forever: plain boxes stand in for them.
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}))

// The files sidebar's tree does not settle in jsdom; what matters here is
// only whether it or Settings' nav holds the sidebar.
vi.mock('@/features/sidebar/app-sidebar', () => ({
  AppSidebar: ({ collapsed }: { collapsed?: boolean }) =>
    collapsed ? <div>Rail</div> : <div>Documents</div>,
}))

const { AppShell } = await import('@/features/shell/app-shell')

// jsdom measures nothing, so motion-panels' observers have nothing to
// watch: plain boxes stand in for its group and panels.
vi.mock('@/components/ui/motion-panels', () => ({
  PanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PanelSeparator: () => <div role="separator" />,
}))
vi.mock('motion-panels/react', () => ({
  Separator: () => <div role="separator" />,
}))

function mount() {
  const store = createStore()
  store.set(activeRemoteAtom, 'mara/notes')
  store.set(vaultsAtom, [
    {
      remote: 'mara/notes',
      path: '/vaults/mara/notes',
      name: 'notes',
      lastOpenedAt: '2026-10-23T10:00:00.000Z',
    },
  ] as never)
  store.set(snapshotAtom, emptyVaultSnapshot())
  store.set(vaultSettingsAtom, { remote: 'mara/notes', settings: SETTINGS })
  store.set(shellWorkspaceAtom, (ws) => openTab(openTab(ws, 'A.md'), 'B.md'))
  render(
    <Provider store={store}>
      <AppShell onAddVault={() => {}} />
    </Provider>,
  )
  return store
}

/** The views in front. */
function views(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-pane]'))
}

function stripOf(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-slot=site-header]')!
}

class LayoutObserver {
  static instances: LayoutObserver[] = []
  readonly observed = new Set<Element>()
  disconnected = false
  constructor(private readonly callback: ResizeObserverCallback) {
    LayoutObserver.instances.push(this)
  }
  observe(target: Element) {
    this.observed.add(target)
  }
  unobserve(target: Element) {
    this.observed.delete(target)
  }
  disconnect() {
    this.disconnected = true
    this.observed.clear()
  }
  deliver(target: Element) {
    if (this.observed.has(target) && !this.disconnected) {
      this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver)
    }
  }
}

test('the tab count follows observed strip and entry layout changes', async () => {
  const previous = globalThis.ResizeObserver
  LayoutObserver.instances = []
  globalThis.ResizeObserver = LayoutObserver as unknown as typeof ResizeObserver
  try {
    const store = mount()
    const list = document.querySelector<HTMLElement>('[role="tablist"]')!
    let clientWidth = 300
    let scrollWidth = 900
    Object.defineProperties(list, {
      clientWidth: { configurable: true, get: () => clientWidth },
      scrollWidth: { configurable: true, get: () => scrollWidth },
    })
    act(() => store.set(shellWorkspaceAtom, (ws) => openTab(openTab(ws, 'C.md'), 'D.md')))
    await waitFor(() => expect(LayoutObserver.instances.length).toBeGreaterThan(0))
    let observer = LayoutObserver.instances.find((candidate) => candidate.observed.has(list))!
    expect(observer.observed.has(list)).toBe(true)
    expect(observer.observed.size).toBe(5)
    act(() => observer.deliver(list))
    expect(stripOf().textContent).toContain('4 tabs')

    clientWidth = 1000
    act(() => observer.deliver(list))
    expect(stripOf().textContent).not.toContain('4 tabs')
    clientWidth = 300
    act(() => observer.deliver(list))
    expect(stripOf().textContent).toContain('4 tabs')

    clientWidth = 920
    act(() => observer.deliver(list))
    expect(stripOf().textContent).not.toContain('4 tabs')

    const previousObserver = observer
    act(() => store.set(shellWorkspaceAtom, splitActive))
    await waitFor(() =>
      expect(
        LayoutObserver.instances.some(
          (candidate) => candidate !== previousObserver && candidate.observed.has(list),
        ),
      ).toBe(true),
    )
    observer = LayoutObserver.instances.find(
      (candidate) => candidate !== previousObserver && candidate.observed.has(list),
    )!
    expect(previousObserver.disconnected).toBe(true)
    expect(observer.observed.has(list)).toBe(true)
    expect(observer.observed.size).toBe(5)
    const split = activeSplit(store.get(shellWorkspaceAtom))!
    const entry = list.querySelector<HTMLElement>(`[data-entry-id="${split.id}"]`)!
    expect(observer.observed.has(entry)).toBe(true)
    scrollWidth = 940
    act(() => observer.deliver(entry))
    expect(stripOf().textContent).toContain('4 tabs')
    scrollWidth = 900
    act(() => observer.deliver(entry))
    expect(stripOf().textContent).not.toContain('4 tabs')
  } finally {
    globalThis.ResizeObserver = previous
  }
})

test('⌘\\\\ makes a split of the tab and a New tab: one pill, two views', async () => {
  const store = mount()
  expect(views()).toHaveLength(1)
  fireEvent.keyDown(window, { key: '\\', ctrlKey: true })
  await waitFor(() => expect(views()).toHaveLength(2))
  const ws = store.get(shellWorkspaceAtom)
  expect(ws.entries).toHaveLength(2)
  expect(isSplit(ws.entries[1])).toBe(true)
  // Both tabs stay in the one strip: A as a tab, the split as a pill.
  const strip = within(stripOf())
  expect(strip.getByRole('tab', { name: 'A' })).toBeTruthy()
  expect(strip.getByRole('tab', { name: 'Split view: B, New tab' })).toBeTruthy()
  // No member has a header of its own or holds tabs: the pill does.
  expect(document.querySelectorAll('[data-slot=pane-header]')).toHaveLength(0)
  expect(within(views()[0]!).queryByRole('tab')).toBeNull()
  expect(within(views()[1]!).queryByRole('tab')).toBeNull()
})

test('a failed split-tab close stays visible and can be retried', async () => {
  const store = mount()
  fireEvent.keyDown(window, { key: '\\', ctrlKey: true })
  await waitFor(() => expect(views()).toHaveLength(2))

  const flush = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error('disk is full'))
    .mockResolvedValue(undefined)
  bufferCleanups.push(registerBuffer(flush))

  fireEvent.click(within(stripOf()).getByRole('button', { name: 'Close split view' }))
  expect(await screen.findByRole('heading', { name: 'Close split tab?' })).toBeTruthy()
  expect(
    screen.getByText(
      'This tab contains multiple views. Closing it will close every view in the split.',
    ),
  ).toBeTruthy()
  const confirm = screen.getByRole('button', { name: 'Close tab' })

  fireEvent.click(confirm)
  expect(await screen.findByRole('alert')).toHaveTextContent('disk is full')
  expect(screen.getByRole('heading', { name: 'Close split tab?' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Close tab' })).toBeTruthy()
  expect(views()).toHaveLength(2)
  expect(activeSplit(store.get(shellWorkspaceAtom))?.views).toEqual([
    'B.md',
    expect.stringMatching(/^holi:new:/),
  ])

  fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))
  await waitFor(() => expect(views()).toHaveLength(1))
  expect(store.get(shellWorkspaceAtom).entries).toEqual(['A.md'])
  expect(flush).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('heading', { name: 'Close split tab?' })).toBeNull()
})

test('selecting another tab shows it alone, the split staying in the strip', async () => {
  const store = mount()
  fireEvent.keyDown(window, { key: '\\', ctrlKey: true })
  await waitFor(() => expect(views()).toHaveLength(2))
  fireEvent.mouseDown(within(stripOf()).getByRole('tab', { name: 'A' }))
  await waitFor(() => expect(views()).toHaveLength(1))
  expect(store.get(shellWorkspaceAtom).active).toBe('A.md')
  expect(within(stripOf()).getByRole('tab', { name: /Split view/ })).toBeTruthy()
})

test("a tab's menu opens it in split view with the active tab", async () => {
  const store = mount()
  fireEvent.contextMenu(within(stripOf()).getByRole('tab', { name: 'A' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: /Open in split view/ }))
  await waitFor(() => expect(views()).toHaveLength(2))
  const ws = store.get(shellWorkspaceAtom)
  expect(ws.entries).toHaveLength(1)
  expect(activeSplit(ws)?.views).toEqual(['B.md', 'A.md'])
  expect(focusedTab(ws)).toBe('A.md')
})

test("a member moves out of its split from the pill's menu", async () => {
  const store = mount()
  fireEvent.contextMenu(within(stripOf()).getByRole('tab', { name: 'A' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: /Open in split view/ }))
  await waitFor(() => expect(views()).toHaveLength(2))
  const left = document.querySelector('[data-member]')!
  fireEvent.contextMenu(left)
  fireEvent.click(await screen.findByRole('menuitem', { name: /Move out of split/ }))
  await waitFor(() => expect(views()).toHaveLength(1))
  const ws = store.get(shellWorkspaceAtom)
  expect(ws.entries).toEqual(['A.md', 'B.md'])
  expect(ws.active).toBe('B.md')
})

test('⌘T opens a New tab; ⇧⌘\\ separates; ⌃⌥→ focuses the next member', async () => {
  const store = mount()
  fireEvent.keyDown(window, { key: 't', ctrlKey: true })
  await waitFor(() => expect(store.get(shellWorkspaceAtom).entries).toHaveLength(3))
  expect(focusedTab(store.get(shellWorkspaceAtom))).toMatch(/^holi:new:/)
  fireEvent.keyDown(window, { key: '\\', ctrlKey: true })
  await waitFor(() => expect(views()).toHaveLength(2))
  const first = focusedTab(store.get(shellWorkspaceAtom))
  fireEvent.keyDown(window, { key: 'ArrowRight', ctrlKey: true, altKey: true })
  await waitFor(() => expect(focusedTab(store.get(shellWorkspaceAtom))).not.toBe(first))
  fireEvent.keyDown(window, { key: '|', ctrlKey: true, shiftKey: true })
  await waitFor(() => expect(views()).toHaveLength(1))
  expect(store.get(shellWorkspaceAtom).entries).toHaveLength(4)
})

/** A drag event at `x`: jsdom's drag events carry no pointer position. */
function at(event: Event, x: number): Event {
  Object.defineProperty(event, 'clientX', { value: x })
  return event
}

/** A drag's data, as jsdom has none. */
function transfer(): DataTransfer {
  const data = new Map<string, string>()
  return {
    get types() {
      return [...data.keys()]
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    effectAllowed: 'all',
    dropEffect: 'none',
  } as unknown as DataTransfer
}

/** jsdom lays nothing out: every box is 1000px wide from the left edge, so
 *  one view's edges are 0 and 1000. */
function layOut() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 1000,
    height: 600,
    right: 1000,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
}

async function catcher(): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-drop-target]')
    expect(el).toBeTruthy()
    return el!
  })
}

test("dragging a strip tab onto the view's right part opens a gap there, and the drop splits", async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  const store = mount()
  layOut()
  const dataTransfer = transfer()
  const tab = document.querySelector<HTMLElement>("[data-tab-key='A.md']")!
  fireEvent.dragStart(tab, { dataTransfer })
  await vi.runAllTimersAsync()
  vi.useRealTimers()
  const target = await catcher()
  fireEvent(target, at(createEvent.dragOver(target, { dataTransfer }), 900))
  await waitFor(() => expect(target.dataset.dropSlot).toBe('insert:1'))
  // The view in front shrinks to the left half; the gap names the tab.
  const body = document.querySelector<HTMLElement>('[data-preview-member]')!
  expect([
    body.style.getPropertyValue('--span-left'),
    body.style.getPropertyValue('--span-width'),
  ]).toEqual(['0px', '500px'])
  const gap = document.querySelector<HTMLElement>('[data-drop-gap]')!
  expect(gap.textContent).toContain('A')
  // Across to the left part: the gap moves there, the view the right half.
  fireEvent(target, at(createEvent.dragOver(target, { dataTransfer }), 100))
  await waitFor(() => expect(target.dataset.dropSlot).toBe('insert:0'))
  expect([
    body.style.getPropertyValue('--span-left'),
    body.style.getPropertyValue('--span-width'),
  ]).toEqual(['500px', '500px'])
  fireEvent(target, at(createEvent.dragOver(target, { dataTransfer }), 900))
  fireEvent(target, at(createEvent.drop(target, { dataTransfer }), 900))
  await waitFor(() => expect(views()).toHaveLength(2))
  const ws = store.get(shellWorkspaceAtom)
  expect(activeSplit(ws)?.views).toEqual(['B.md', 'A.md'])
  expect(ws.entries).toHaveLength(1)
  // The drag is over: no catcher left over the views.
  await waitFor(() => expect(document.querySelector('[data-drop-target]')).toBeNull())
  vi.restoreAllMocks()
})

test('a view not open yet, dragged from the sidebar, opens in the gap', async () => {
  const store = mount()
  layOut()
  const dataTransfer = transfer()
  dataTransfer.setData('application/x-holi-tab', 'C.md')
  store.set(tabDragAtom, 'C.md')
  const target = await catcher()
  fireEvent(target, at(createEvent.dragOver(target, { dataTransfer }), 50))
  await waitFor(() => expect(target.dataset.dropSlot).toBe('insert:0'))
  fireEvent(target, at(createEvent.drop(target, { dataTransfer }), 50))
  await waitFor(() => expect(views()).toHaveLength(2))
  const ws = store.get(shellWorkspaceAtom)
  expect(activeSplit(ws)?.views).toEqual(['C.md', 'B.md'])
  expect(ws.entries.map((e) => (typeof e === 'string' ? e : 'split'))).toEqual(['A.md', 'split'])
  vi.restoreAllMocks()
})
