/**
 * Split tabs in the shell (docs/features/tabs-panes.md): one strip in the
 * title band holds every tab, a split view being one pill of it; ⌘\\, a
 * tab's menu and a drag make a split; its members carry thin headers.
 */
import { useEffect, useState } from 'react'
import { undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { Provider, atom, createStore } from 'jotai'
import { afterEach, expect, test, vi } from 'vitest'
import { Input } from '@/components/ui/input'
import { coreContributionAtom, installedPluginsAtom } from '@/state/plugins'
import type { AgentsMode, RendererPlugin } from '@/state/plugin-types'
import { tabKey } from '@/state/tab-descriptor'
import { closeTab, selectEntry, separate, openInSplit } from '@/state/shell-workspace'
import {
  VAULT_SETTING_DEFAULTS,
  emptyVaultSnapshot,
  type ResolvedVaultSettings,
} from '@holi/shared'

import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@/test/render'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { activeSplit, focusedTab, isSplit, openTab, splitActive } from '@/state/shell-workspace'
import { vaultSettingsAtom } from '@/state/settings'
import { Overview } from '@/features/planning/overview'
import { tabDragAtom } from '@/features/shell/use-tab-drag'
import { registerBuffer } from '@/lib/buffer-registry'
import { agentsSelectionAtom } from '@/state/agents-slots'
import { activeRemoteAtom, historyEpochsAtom, snapshotAtom, vaultsAtom } from '@/state/vaults'

const historyActivityQuery = vi.hoisted(() => vi.fn(async () => []))

const graphQuery = vi.hoisted(() => vi.fn())

const write = vi.fn(async (_input: unknown) => ({
  ok: true as const,
  warnings: [] as string[],
}))
const readFile = vi.fn(async () => 'first line\nsecond line\nthird line')

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
    name === 'notes.graph'
      ? graphQuery()
      : name === 'notes.read'
        ? readFile()
        : name === 'github.fileContributors'
          ? []
          : name === 'settings.read'
            ? SETTINGS
            : name === 'history.activity'
              ? historyActivityQuery()
              : name === 'settings.pluginFailures'
                ? {}
                : name === 'github.collaborators'
                  ? { visibility: 'private', collaborators: [] }
                  : ['activity.entries', 'logs.entries', 'terminal.list'].includes(name)
                    ? []
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
vi.mock('@/features/history/file-history-button', () => ({
  FileHistoryButton: () => null,
}))

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

function mount(initial = ['A.md', 'B.md'], files: { path: string; updatedAt: string }[] = []) {
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
  store.set(snapshotAtom, { ...emptyVaultSnapshot(), files })
  store.set(vaultSettingsAtom, { remote: 'mara/notes', settings: SETTINGS })
  store.set(shellWorkspaceAtom, (ws) => {
    const opened = initial
      .slice(1)
      .reduce((next, key) => openTab(next, key), openTab(ws, initial[0]!))
    return files.length === 0 ? opened : selectEntry(opened, initial[0]!)
  })
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

test('a core text file keeps its CodeMirror instance and undo history when its tab is hidden', async () => {
  readFile.mockClear()
  const store = mount(
    ['notes/source', 'Other.md'],
    [{ path: 'notes/source', updatedAt: '2026-10-23T10:00:00.000Z' }],
  )
  expect(store.get(shellWorkspaceAtom).entries).toContain('Other.md')
  await waitFor(() => expect(document.querySelector('.cm-editor')).not.toBeNull())
  const editor = document.querySelector('.cm-editor')!
  const content = document.querySelector<HTMLElement>('.cm-content')!
  const cm = EditorView.findFromDOM(editor as HTMLElement)!
  cm.dispatch({ changes: { from: cm.state.doc.length, insert: ' edited' } })
  await waitFor(() => expect(content.textContent).toContain('edited'))
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, 'Other.md')))
  await waitFor(() => expect(document.querySelector('[data-pane-host="Other.md"]')).not.toBeNull())
  act(() => store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, 'notes/source')))
  await waitFor(() =>
    expect(document.querySelector('[data-pane-host="notes/source"] .cm-editor')).toBe(editor),
  )
  expect(document.querySelector('.cm-content')?.textContent).toContain('edited')
  undo(cm)
  expect(
    document.querySelector('[data-pane-host="notes/source"] .cm-content')?.textContent,
  ).not.toContain('edited')
  expect(store.get(shellWorkspaceAtom).active).toBe('notes/source')
})

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
  await waitFor(() =>
    expect(screen.queryByRole('heading', { name: 'Close split tab?' })).toBeNull(),
  )
})

test('selecting another tab shows it alone, the split staying in the strip', async () => {
  const store = mount()
  fireEvent.keyDown(window, { key: '\\', ctrlKey: true })
  await waitFor(() => expect(views()).toHaveLength(2))
  const tab = within(stripOf()).getByRole('tab', { name: 'A' })
  fireEvent.mouseDown(tab)
  expect(views()).toHaveLength(2)
  fireEvent.click(tab)
  await waitFor(() => expect(views()).toHaveLength(1))
  expect(store.get(shellWorkspaceAtom).active).toBe('A.md')
  expect(within(stripOf()).getByRole('tab', { name: /Split view/ })).toBeTruthy()
})

test('primary-modifier click opens a background tab beside the active tab', async () => {
  const store = mount()
  const tab = within(stripOf()).getByRole('tab', { name: 'A' })
  fireEvent.click(tab, { metaKey: true })
  await waitFor(() => expect(views()).toHaveLength(2))
  expect(activeSplit(store.get(shellWorkspaceAtom))?.views).toEqual(['B.md', 'A.md'])
  expect(focusedTab(store.get(shellWorkspaceAtom))).toBe('A.md')
})

test.each([{ metaKey: true }, { ctrlKey: true }, { altKey: true }])(
  'a modifier click opens a tab beside the current view (%o)',
  async (modifier) => {
    const store = mount()
    fireEvent.click(within(stripOf()).getByRole('tab', { name: 'A' }), modifier)
    await waitFor(() => expect(views()).toHaveLength(2))
    expect(activeSplit(store.get(shellWorkspaceAtom))?.views).toEqual(['B.md', 'A.md'])
  },
)

test('pressing a background tab does not activate it before native drag starts', async () => {
  const store = mount()
  const tab = document.querySelector<HTMLElement>("[data-tab-key='A.md']")!
  fireEvent.pointerDown(tab, { button: 0 })
  expect(store.get(shellWorkspaceAtom).active).toBe('B.md')
  expect(views()).toHaveLength(1)
  fireEvent.dragStart(tab, { dataTransfer: transfer() })
  await waitFor(() => expect(store.get(shellWorkspaceAtom).active).toBe('B.md'))
  fireEvent.dragEnd(tab)
  expect(store.get(shellWorkspaceAtom).active).toBe('B.md')
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

test('parked surface focus returns to the shell after a control or iframe takes focus', async () => {
  const { show, away } = retainedFixture()
  show('demo.deck')
  const control = await screen.findByRole('textbox', { name: 'State demo.deck' })
  const outside = within(stripOf()).getByRole('tab', { name: 'A' })
  await act(async () => outside.focus())
  away()
  await waitFor(() => expect(document.activeElement).toBe(outside))
  await act(async () => control.focus())
  expect(document.activeElement).toBe(outside)

  show('demo.deck')
  const iframe = document.createElement('iframe')
  control.closest('[data-pane-host]')!.append(iframe)
  away()
  // A remote frame signals window blur, not a bubbling focusin. Suppress
  // jsdom's local focus events while allowing activeElement to really change.
  const stopLocalFocus = (event: Event) => event.stopImmediatePropagation()
  window.addEventListener('focus', stopLocalFocus, true)
  window.addEventListener('focusin', stopLocalFocus, true)
  const outsideFocus = vi.spyOn(outside, 'focus')
  try {
    await act(async () => {
      iframe.focus()
      fireEvent.blur(window)
    })
    expect(document.activeElement).toBe(outside)
    expect(outsideFocus).toHaveBeenCalledWith({ preventScroll: true })
    outsideFocus.mockClear()
    // A background remote frame can change focus without either parent
    // focus signal. The parked-host watcher must catch that too.
    iframe.focus()
    await waitFor(() => expect(document.activeElement).toBe(outside))
    expect(outsideFocus).toHaveBeenCalledWith({ preventScroll: true })
  } finally {
    window.removeEventListener('focus', stopLocalFocus, true)
    window.removeEventListener('focusin', stopLocalFocus, true)
  }
})

test('a parked host starts and stops its iframe focus watchdog as frames change', async () => {
  const f = retainedFixture()
  f.show('late-frame')
  const input = await screen.findByRole('textbox', { name: 'State late-frame' })
  const outside = within(stripOf()).getByRole('tab', { name: 'A' })
  await act(async () => outside.focus())
  f.away()

  const stopLocalFocus = (event: Event) => event.stopImmediatePropagation()
  window.addEventListener('focus', stopLocalFocus, true)
  window.addEventListener('focusin', stopLocalFocus, true)
  vi.useFakeTimers()
  try {
    const baselineTimers = vi.getTimerCount()
    const host = input.closest('[data-pane-host]')!
    const iframe = document.createElement('iframe')
    host.append(iframe)
    await act(async () => Promise.resolve())
    expect(vi.getTimerCount()).toBeGreaterThan(baselineTimers)
    iframe.focus()
    await act(async () => vi.advanceTimersByTime(250))
    expect(document.activeElement).toBe(outside)

    iframe.remove()
    await act(async () => vi.advanceTimersByTime(250))
    expect(vi.getTimerCount()).toBe(baselineTimers)
  } finally {
    vi.useRealTimers()
    window.removeEventListener('focus', stopLocalFocus, true)
    window.removeEventListener('focusin', stopLocalFocus, true)
  }
})

test('programmatically parking a focused surface releases focus and visible members retain it', async () => {
  const f = retainedFixture()
  f.show('one')
  const first = await screen.findByRole('textbox', { name: 'State one' })
  await act(async () => first.focus())
  expect(document.activeElement).toBe(first)
  const bodyFocus = vi.spyOn(document.body, 'focus')
  // Native moves retain focus silently. Suppress jsdom/React's local
  // focus signals so release cannot rely on a fresh focusin or window blur.
  const stopLocalFocus = (event: Event) => event.stopImmediatePropagation()
  window.addEventListener('focus', stopLocalFocus, true)
  window.addEventListener('focusin', stopLocalFocus, true)
  try {
    f.away()
    await waitFor(() => expect(bodyFocus).toHaveBeenCalledWith({ preventScroll: true }))
    expect(document.activeElement).not.toBe(first)
  } finally {
    window.removeEventListener('focus', stopLocalFocus, true)
    window.removeEventListener('focusin', stopLocalFocus, true)
  }

  f.show('one')
  act(() => f.store.set(shellWorkspaceAtom, (ws) => openInSplit(ws, f.key('two'))))
  const second = await screen.findByRole('textbox', { name: 'State two' })
  for (const [id, input] of [
    ['one', first],
    ['two', second],
  ] as const) {
    await act(async () => input.focus())
    expect(document.activeElement).toBe(input)
    expect(focusedTab(f.store.get(shellWorkspaceAtom))).toBe(f.key(id))
    expect(input).toHaveAttribute('data-visible', 'true')
  }
})

test('parked focus falls back to body after the last outside target is removed', async () => {
  const { show, away } = retainedFixture()
  const outside = document.createElement('button')
  document.body.append(outside)
  await act(async () => outside.focus())
  show('demo.deck')
  const control = await screen.findByRole('textbox', { name: 'State demo.deck' })
  away()
  outside.remove()
  const originalTabIndex = document.body.getAttribute('tabindex')
  await act(async () => control.focus())
  expect(document.activeElement).toBe(document.body)
  expect(document.body.getAttribute('tabindex')).toBe(originalTabIndex)
})

test('retained focus guards remove their global handlers on unmount', async () => {
  const addWindow = vi.spyOn(window, 'addEventListener')
  const removeWindow = vi.spyOn(window, 'removeEventListener')
  const addDocument = vi.spyOn(document, 'addEventListener')
  const removeDocument = vi.spyOn(document, 'removeEventListener')
  const clearTimer = vi.spyOn(window, 'clearTimeout')
  const scheduleTimer = vi.spyOn(window, 'setTimeout')
  const f = retainedFixture()
  f.show('one')
  const input = await screen.findByRole('textbox', { name: 'State one' })
  input.closest('[data-pane-host]')!.append(document.createElement('iframe'))
  f.away()
  const windowFocus = addWindow.mock.calls.filter(([type]) => ['blur', 'focus'].includes(type))
  const documentFocus = addDocument.mock.calls.filter(
    ([type, , capture]) => ['focus', 'focusin'].includes(type) && capture === true,
  )
  expect(windowFocus.length).toBeGreaterThan(0)
  expect(documentFocus.map(([type]) => type)).toContain('focusin')
  act(() => input.focus())
  cleanup()
  await act(async () => {})
  for (const call of windowFocus) expect(removeWindow.mock.calls).toContainEqual(call)
  for (const call of documentFocus) expect(removeDocument.mock.calls).toContainEqual(call)
  expect(scheduleTimer.mock.calls.some(([, delay]) => delay === 250)).toBe(true)
  expect(clearTimer).toHaveBeenCalled()
})

test('a visited keepMounted surface keeps its document and lease while another tab is shown', async () => {
  const acquired = vi.fn()
  const released = vi.fn()
  function Document({ visible }: { visible: boolean }) {
    useEffect(() => {
      acquired()
      return () => {
        released()
      }
    }, [])
    return (
      <Input aria-label="Volatile document state" data-visible={visible} defaultValue="initial" />
    )
  }
  const store = mount()
  const key = tabKey({ kind: 'surface', surface: 'test-document', id: 'demo.deck' })
  act(() => {
    store.set(coreContributionAtom, {
      surfaces: [
        {
          kind: 'test-document',
          label: 'Deck',
          icon: () => null,
          keepMounted: true,
          render: Document,
        },
      ],
      rail: [],
      claims: [],
    })
    store.set(shellWorkspaceAtom, (ws) => openTab(ws, key))
  })
  const input = await screen.findByRole('textbox', { name: 'Volatile document state' })
  fireEvent.change(input, { target: { value: 'keep this unsaved value' } })
  act(() => store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, 'A.md')))
  expect(document.querySelector('[aria-label="Volatile document state"]')).toBe(input)
  expect(input.isConnected).toBe(true)
  expect(input.closest('[inert]')).not.toBeNull()
  expect(input.getAttribute('data-visible')).toBe('false')
  expect(released).not.toHaveBeenCalled()
  act(() => store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, key)))
  expect(await screen.findByRole('textbox', { name: 'Volatile document state' })).toBe(input)
  expect(input).toHaveValue('keep this unsaved value')
  expect(acquired).toHaveBeenCalledTimes(1)
  act(() => store.set(shellWorkspaceAtom, (ws) => closeTab(ws, key)))
  await waitFor(() => expect(released).toHaveBeenCalledTimes(1))
})

function retainedFixture(keepMounted = true, surfaceKind = 'test-document', vaultApp = false) {
  const acquired = vi.fn()
  const released = vi.fn()
  function Document({ id, visible }: { id?: string; visible: boolean }) {
    useEffect(() => {
      acquired(id)
      return () => {
        released(id)
      }
    }, [id])
    return <Input aria-label={`State ${id}`} data-visible={visible} defaultValue="initial" />
  }
  const store = mount()
  const surface = {
    kind: surfaceKind,
    label: 'Deck',
    icon: () => null,
    render: Document,
    ...(keepMounted ? { keepMounted: true as const } : {}),
  }
  const install = (enabled: boolean) =>
    store.set(coreContributionAtom, { surfaces: enabled ? [surface] : [], rail: [], claims: [] })
  act(() => install(true))
  const key = (id: string) =>
    tabKey(
      vaultApp ? { kind: 'vault-app', path: id } : { kind: 'surface', surface: surface.kind, id },
    )
  const show = (id: string) =>
    act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, key(id))))
  const away = () => act(() => store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, 'A.md')))
  return { store, acquired, released, key, show, away, install }
}

test('five opted-in agent terminal surfaces keep one view each and release on close', async () => {
  const f = retainedFixture(true, 'agent')
  const ids = ['terminal-one', 'terminal-two', 'terminal-three', 'terminal-four', 'terminal-five']
  const inputs = new Map<string, HTMLElement>()
  for (const id of ids) {
    f.show(id)
    inputs.set(id, await screen.findByRole('textbox', { name: `State ${id}` }))
  }
  for (const id of ids) {
    f.show(id)
    expect(await screen.findByRole('textbox', { name: `State ${id}` })).toBe(inputs.get(id))
    for (const other of ids) {
      expect(inputs.get(other)?.isConnected).toBe(true)
      expect(inputs.get(other)?.closest('[inert]') !== null).toBe(other !== id)
    }
  }
  expect(f.acquired.mock.calls).toEqual(ids.map((id) => [id]))
  expect(f.released).not.toHaveBeenCalled()
  for (const id of ids) {
    act(() => f.store.set(shellWorkspaceAtom, (ws) => closeTab(ws, f.key(id))))
  }
  await waitFor(() => expect(f.released).toHaveBeenCalledTimes(ids.length))
  for (const input of inputs.values()) expect(input.isConnected).toBe(false)
})

test('a parked graph highlights its own split companion, not the focused tab', async () => {
  graphQuery.mockReset()
  const widths = ['clientWidth', 'clientHeight'] as const
  const previous = widths.map((name) =>
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
  )
  for (const name of widths) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => 600 })
  }
  graphQuery.mockResolvedValue({ nodes: ['A.md', 'B.md'], edges: [[0, 1]], total: 2 })
  const store = mount()
  const key = 'holi:graph'
  act(() => store.set(shellWorkspaceAtom, (ws) => openInSplit(ws, key)))
  await waitFor(() => expect(document.querySelector('[data-graph-node="B.md"]')).not.toBeNull())
  act(() => store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, 'A.md')))
  expect(document.querySelector('[data-graph-node="B.md"] circle')).toHaveClass('fill-primary')
  expect(document.querySelector('[data-graph-node="A.md"] circle')).not.toHaveClass('fill-primary')
  widths.forEach((name, i) => {
    const descriptor = previous[i]
    if (descriptor === undefined) delete (HTMLElement.prototype as never)[name]
    else Object.defineProperty(HTMLElement.prototype, name, descriptor)
  })
})

test('a visited graph stays mounted through tabs and refetches after close and reopen', async () => {
  graphQuery.mockReset()
  graphQuery.mockResolvedValue({ nodes: ['Plan.md'], edges: [], total: 1 })
  const store = mount()
  const key = 'holi:graph'
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, key)))
  await waitFor(() => expect(document.querySelector('[data-graph-view]')).not.toBeNull())
  const graphView = document.querySelector('[data-graph-view]')
  expect(graphQuery).toHaveBeenCalledTimes(1)

  act(() => store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, 'A.md')))
  expect(document.querySelector('[data-graph-view]')).toBe(graphView)
  act(() => store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, key)))
  expect(document.querySelector('[data-graph-view]')).toBe(graphView)
  expect(graphQuery).toHaveBeenCalledTimes(1)

  act(() => store.set(shellWorkspaceAtom, (ws) => closeTab(ws, key)))
  await waitFor(() => expect(document.querySelector('[data-graph-view]')).toBeNull())
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, key)))
  await waitFor(() => expect(graphQuery).toHaveBeenCalledTimes(2))
})

test('retained surfaces mount only after first display and close/reopen starts fresh', async () => {
  const f = retainedFixture()
  act(() =>
    f.store.set(shellWorkspaceAtom, (ws) =>
      selectEntry(openTab(openTab(ws, f.key('one')), f.key('two')), f.key('one')),
    ),
  )
  const first = await screen.findByRole('textbox', { name: 'State one' })
  expect(document.querySelector('[aria-label="State two"]')).toBeNull()
  expect(f.acquired.mock.calls).toEqual([['one']])
  fireEvent.change(first, { target: { value: 'unsaved state' } })
  f.away()
  f.show('one')
  expect(await screen.findByRole('textbox', { name: 'State one' })).toBe(first)
  act(() => f.store.set(shellWorkspaceAtom, (ws) => closeTab(ws, f.key('one'))))
  expect(f.released).toHaveBeenCalledTimes(1)
  f.show('one')
  expect(await screen.findByRole('textbox', { name: 'State one' })).not.toBe(first)
  expect(screen.getByRole('textbox', { name: 'State one' })).toHaveValue('initial')
  expect(f.acquired.mock.calls.filter(([id]) => id === 'one')).toHaveLength(2)
})

test('the visited Planning board retains its view and unfinished dialog across tab switches', async () => {
  const store = mount()
  const board = tabKey({ kind: 'board' })
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, board)))

  const view = await screen.findByLabelText('Search tasks')
  const host = view.closest<HTMLElement>('[data-pane-host]')!
  fireEvent.change(view, { target: { value: 'retain this search' } })
  act(() => store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, 'A.md')))
  expect(view.isConnected).toBe(true)
  expect(host.parentElement).toHaveAttribute('data-retained-parking')

  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, board)))
  expect(await screen.findByLabelText('Search tasks')).toBe(view)
  expect(view).toHaveValue('retain this search')

  fireEvent.click(within(host).getAllByRole('button', { name: 'New task' }).at(-1)!)
  const title = await screen.findByPlaceholderText('Task title')
  fireEvent.change(title, { target: { value: 'an unfinished draft' } })
  act(() => store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, 'A.md')))
  expect(screen.queryByRole('heading', { name: 'New task' })).toBeNull()
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, board)))
  expect(await screen.findByDisplayValue('an unfinished draft')).toBeTruthy()

  act(() => store.set(shellWorkspaceAtom, (ws) => closeTab(ws, board)))
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, board)))
  expect(await screen.findByLabelText('Search tasks')).not.toBe(view)
  // The shared Planning filter atoms intentionally outlive a tab instance.
  expect(screen.getByLabelText('Search tasks')).toHaveValue('retain this search')
})

test('Planning stays displayed but unfocused in a split without losing its host', async () => {
  const store = mount()
  const board = tabKey({ kind: 'board' })
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, board)))
  const input = await screen.findByLabelText('Search tasks')
  const host = input.closest<HTMLElement>('[data-pane-host]')!

  act(() => store.set(shellWorkspaceAtom, (ws) => openInSplit(ws, 'A.md')))

  expect(input.isConnected).toBe(true)
  expect(host.parentElement).not.toHaveAttribute('data-retained-parking')
  expect(activeSplit(store.get(shellWorkspaceAtom))?.views).toContain(board)
  expect(activeSplit(store.get(shellWorkspaceAtom))?.focused).toBe('A.md')
})

test('Planning pauses and refreshes recent activity while its tab is hidden', async () => {
  historyActivityQuery.mockClear()
  const store = createStore()
  const props = {
    projectState: {
      state: 'ready' as const,
      project: { status: 'planning' as const, milestones: [], about: '' },
    },
    fallbackName: 'Notes',
    tasks: [],
    tasksLoading: false,
    statuses: [],
    now: '2026-10-23T10:00:00.000Z',
    today: '2026-10-23',
    members: [],
    onEditProject: () => {},
    onRetryProject: () => {},
    onOpenTask: () => {},
    onShowStatus: () => {},
    onNewTask: () => {},
  }
  const view = render(
    <Provider store={store}>
      <Overview {...props} visible />
    </Provider>,
  )
  await waitFor(() => expect(historyActivityQuery).toHaveBeenCalledTimes(1))

  view.rerender(
    <Provider store={store}>
      <Overview {...props} visible={false} />
    </Provider>,
  )
  act(() => store.set(historyEpochsAtom, { all: 1, byPath: {} }))
  expect(historyActivityQuery).toHaveBeenCalledTimes(1)

  view.rerender(
    <Provider store={store}>
      <Overview {...props} visible />
    </Provider>,
  )
  await waitFor(() => expect(historyActivityQuery).toHaveBeenCalledTimes(2))
})

test('parked retained surfaces preserve their viewport size and restore responsive sizing', async () => {
  const f = retainedFixture()
  f.show('one')
  const input = await screen.findByRole('textbox', { name: 'State one' })
  const host = input.closest<HTMLElement>('[data-pane-host]')!
  const parking = document.querySelector<HTMLElement>('[data-retained-parking]')!
  const measured = vi.fn()
  const measureHost = vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => {
    measured(host.parentElement, host.style.width, host.style.height, host.inert)
    return {
      left: 0,
      top: 0,
      width: 640,
      height: 480,
      right: 640,
      bottom: 480,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
  })

  f.away()

  expect(host.parentElement).toBe(parking)
  expect(host.style.width).toBe('640px')
  expect(host.style.height).toBe('480px')
  expect(parking).toHaveAttribute('aria-hidden', 'true')
  expect(parking).toHaveAttribute('inert')
  expect(parking).not.toHaveAttribute('hidden')
  expect(parking.style.display).toBe('')
  expect(parking.className).toContain('invisible')
  expect(parking.className).toContain('pointer-events-none')
  // Fixing dimensions and making a host inert dirties layout. Settle that
  // layout before moving it, both into parking and back to the visible slot.
  expect(measureHost).toHaveBeenCalledTimes(2)
  expect(measured).toHaveBeenLastCalledWith(expect.any(HTMLElement), '640px', '480px', true)
  expect(measured.mock.calls.at(-1)![0]).not.toBe(parking)

  f.show('one')

  expect(host.parentElement).not.toBe(parking)
  expect(measureHost).toHaveBeenCalledTimes(3)
  expect(measured).toHaveBeenLastCalledWith(parking, '640px', '480px', true)
  expect(host.style.width).toBe('')
  expect(host.style.height).toBe('')
  expect(host.className).toContain('w-full')
})

test('both split members stay visible regardless focus, and separating parks rather than remounts', async () => {
  const f = retainedFixture()
  f.show('one')
  act(() => f.store.set(shellWorkspaceAtom, (ws) => openInSplit(ws, f.key('two'))))
  const first = await screen.findByRole('textbox', { name: 'State one' })
  const second = await screen.findByRole('textbox', { name: 'State two' })
  expect(first.getAttribute('data-visible')).toBe('true')
  expect(second.getAttribute('data-visible')).toBe('true')
  fireEvent.pointerDown(first)
  expect(second.getAttribute('data-visible')).toBe('true')
  act(() => f.store.set(shellWorkspaceAtom, (ws) => separate(ws, activeSplit(ws)!.id)))
  expect(first.isConnected).toBe(true)
  expect(second.isConnected).toBe(true)
  expect(
    [first, second].filter((input) => input.getAttribute('data-visible') === 'true'),
  ).toHaveLength(1)
  expect(f.acquired).toHaveBeenCalledTimes(2)
  expect(f.released).not.toHaveBeenCalled()
})

test('removing a retained surface claim releases hidden content and does not eagerly recreate it', async () => {
  const f = retainedFixture()
  f.show('one')
  const first = await screen.findByRole('textbox', { name: 'State one' })
  f.away()
  act(() => f.install(false))
  expect(first.isConnected).toBe(false)
  expect(f.released).toHaveBeenCalledTimes(1)
  act(() => f.install(true))
  expect(f.acquired).toHaveBeenCalledTimes(1)
  f.show('one')
  expect(await screen.findByRole('textbox', { name: 'State one' })).not.toBe(first)
})

test('the same surface id in another vault gets a fresh instance', async () => {
  const f = retainedFixture()
  f.show('one')
  const first = await screen.findByRole('textbox', { name: 'State one' })
  fireEvent.change(first, { target: { value: 'vault A only' } })
  act(() => f.store.set(activeRemoteAtom, 'mara/other'))
  f.show('one')
  const second = await screen.findByRole('textbox', { name: 'State one' })
  expect(second).not.toBe(first)
  expect(second).toHaveValue('initial')
  expect(first.isConnected).toBe(false)
  expect(f.released).toHaveBeenCalledTimes(1)
})

test('surfaces without keepMounted retain their existing unmount-on-leave behavior', async () => {
  const f = retainedFixture(false)
  f.show('one')
  const first = await screen.findByRole('textbox', { name: 'State one' })
  f.away()
  expect(first.isConnected).toBe(false)
  expect(f.released).toHaveBeenCalledTimes(1)
  f.show('one')
  expect(await screen.findByRole('textbox', { name: 'State one' })).not.toBe(first)
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
  fireEvent.mouseDown(tab, { button: 0 })
  expect(store.get(shellWorkspaceAtom).active).toBe('B.md')
  expect(views()).toHaveLength(1)
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
  expect(store.get(tabDragAtom)).toBeNull()
  vi.restoreAllMocks()
})

test('a background tab dropped at the left edge splits beside the original active view', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  const store = mount()
  layOut()
  const dataTransfer = transfer()
  const tab = document.querySelector<HTMLElement>("[data-tab-key='A.md']")!
  fireEvent.mouseDown(tab, { button: 0 })
  expect(store.get(shellWorkspaceAtom).active).toBe('B.md')
  fireEvent.dragStart(tab, { dataTransfer })
  await vi.runAllTimersAsync()
  vi.useRealTimers()
  const target = await catcher()
  fireEvent(target, at(createEvent.dragOver(target, { dataTransfer }), 50))
  fireEvent(target, at(createEvent.drop(target, { dataTransfer }), 50))
  await waitFor(() => expect(activeSplit(store.get(shellWorkspaceAtom))).not.toBeNull())
  expect(activeSplit(store.get(shellWorkspaceAtom))?.views).toEqual(['A.md', 'B.md'])
  expect(store.get(shellWorkspaceAtom).active).toBe(activeSplit(store.get(shellWorkspaceAtom))?.id)
  vi.restoreAllMocks()
})

test('a view not open yet, dragged from the sidebar, opens in the gap', async () => {
  const store = mount()
  layOut()
  const dataTransfer = transfer()
  dataTransfer.setData('application/x-holi-tab', 'C.md')
  store.set(tabDragAtom, { key: 'C.md', vault: 'mara/notes', wasOpen: false })
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

test('vault-app descriptors retain the registered app view through the real tab wrapper and split layout', async () => {
  const f = retainedFixture(true, 'app', true)
  act(() =>
    f.store.set(shellWorkspaceAtom, (ws) => selectEntry(openTab(ws, f.key('Two.app')), 'A.md')),
  )
  expect(f.acquired).not.toHaveBeenCalled()
  f.show('One.app')
  const one = await screen.findByRole('textbox', { name: 'State One.app' })
  expect(screen.getByRole('button', { name: 'Edit source' })).toBeTruthy()
  f.away()
  expect(one.isConnected).toBe(true)
  expect(one).toHaveAttribute('data-visible', 'false')
  f.show('One.app')
  act(() => f.store.set(shellWorkspaceAtom, (ws) => openInSplit(ws, f.key('Two.app'))))
  const two = await screen.findByRole('textbox', { name: 'State Two.app' })
  for (const input of [one, two]) expect(input).toHaveAttribute('data-visible', 'true')
  act(() => f.store.set(shellWorkspaceAtom, (ws) => separate(ws, activeSplit(ws)!.id)))
  expect(one.isConnected).toBe(true)
  expect(two.isConnected).toBe(true)
  f.away()
  act(() => f.store.set(shellWorkspaceAtom, (ws) => closeTab(ws, f.key('One.app'))))
  expect(one.isConnected).toBe(false)
  f.show('One.app')
  expect(await screen.findByRole('textbox', { name: 'State One.app' })).not.toBe(one)
})

/** Real session descriptors reach this adapter through TabView's Agents mode,
 * not the unrelated keepMounted surface seam. State belongs to each mounted
 * view, just as a terminal's unsent input and viewport belong to its instance. */
function sessionFixture(
  keepsSelectionMounted: AgentsMode['keepsSelectionMounted'] = ({ owner }) => owner === 'agent',
  documentPath = 'A.md',
  files: { path: string; updatedAt: string }[] = [],
) {
  const acquired = vi.fn()
  const disposed = vi.fn()
  let nextInstance = 0
  const Main: AgentsMode['main'] = ({ selection, visible }) => {
    const [instance] = useState(() => ++nextInstance)
    const [text, setText] = useState('initial')
    const name = selection === null ? 'home' : `${selection.owner}:${selection.id}`
    useEffect(() => {
      acquired(name, instance)
      return () => {
        disposed(name, instance)
      }
    }, [name, instance])
    return (
      <Input
        aria-label={`Session ${name}`}
        data-instance={instance}
        data-visible={String(visible)}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    )
  }
  const plugin: RendererPlugin = {
    info: { id: 'agent', label: 'Agent', default: true, builtIn: true },
    agentsMode: {
      sidebar: () => null,
      main: Main,
      status: atom({ needsYou: 0, working: 0 }),
      keepsSelectionMounted,
    },
  }
  const store = mount([documentPath, 'Other.md'], files)
  act(() => store.set(installedPluginsAtom, [plugin]))
  const key = (id: string, owner = 'agent') => tabKey({ kind: 'session', owner, id })
  const show = (id: string, owner = 'agent') =>
    act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, key(id, owner))))
  const away = () => act(() => store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, documentPath)))
  return { store, plugin, acquired, disposed, key, show, away }
}

test('an Ask returns to its retained session host and closing releases it', async () => {
  const f = sessionFixture()
  act(() => f.store.set(agentsSelectionAtom, { owner: 'agent', id: 'session-one' }))
  const input = await screen.findByRole('textbox', { name: 'Session agent:session-one' })
  const instance = input.dataset.instance

  // The PDF Ask lands on the session selection, which the shell turns into
  // the one canonical session tab instead of a second agent surface.
  f.away()
  expect(input.isConnected).toBe(true)
  expect(input.closest('[inert]')).not.toBeNull()
  act(() => f.store.set(agentsSelectionAtom, { owner: 'agent', id: 'session-one' }))
  expect(await screen.findByRole('textbox', { name: 'Session agent:session-one' })).toBe(input)
  expect(input.dataset.instance).toBe(instance)

  act(() => f.store.set(shellWorkspaceAtom, (ws) => closeTab(ws, f.key('session-one'))))
  await waitFor(() => expect(input.isConnected).toBe(false))
  expect(f.disposed).toHaveBeenCalledTimes(1)
})

test('session retention: document and session switches preserve connected DOM and local state', async () => {
  const f = sessionFixture()
  f.show('one')
  const first = await screen.findByRole('textbox', { name: 'Session agent:one' })
  const instance = first.dataset.instance
  expect(first).toHaveAttribute('data-visible', 'true')
  fireEvent.change(first, { target: { value: 'unsent input and viewport state' } })

  f.away()
  // Assert connection before looking for it again: a replacement with restored
  // text is not the original live terminal document.
  expect(first.isConnected).toBe(true)
  expect(first.closest('[inert]')).not.toBeNull()
  expect(first).toHaveAttribute('data-visible', 'false')
  expect(document.querySelector('[aria-label="Session agent:one"]')).toBe(first)
  expect(f.disposed).not.toHaveBeenCalled()

  f.show('two')
  const second = await screen.findByRole('textbox', { name: 'Session agent:two' })
  fireEvent.change(second, { target: { value: 'second session only' } })
  f.show('one')
  expect(await screen.findByRole('textbox', { name: 'Session agent:one' })).toBe(first)
  expect(first).toHaveAttribute('data-instance', instance)
  expect(first).toHaveValue('unsent input and viewport state')
  expect(first).toHaveAttribute('data-visible', 'true')
  expect(first.closest('[inert]')).toBeNull()
  expect(second.isConnected).toBe(true)
  expect(second).toHaveAttribute('data-visible', 'false')
  f.away()
  f.show('two')
  expect(await screen.findByRole('textbox', { name: 'Session agent:two' })).toBe(second)
  expect(second).toHaveValue('second session only')
  expect(f.acquired.mock.calls).toEqual([
    ['agent:one', Number(instance)],
    ['agent:two', Number(second.dataset.instance)],
  ])
  expect(f.disposed).not.toHaveBeenCalled()
})

test('core text and agent session retain their live state together across tab switches', async () => {
  const f = sessionFixture(undefined, 'notes/source', [
    { path: 'notes/source', updatedAt: '2026-10-23T10:00:00.000Z' },
  ])
  await waitFor(() => expect(document.querySelector('.cm-editor')).not.toBeNull())
  const editor = document.querySelector('.cm-editor')!
  f.show('one')
  const session = await screen.findByRole('textbox', { name: 'Session agent:one' })
  fireEvent.change(session, { target: { value: 'unsent agent input' } })
  expect(editor.isConnected).toBe(true)
  expect(document.querySelector('[data-pane-host="notes/source"] .cm-editor')).toBe(editor)

  f.away()
  expect(editor.isConnected).toBe(true)
  expect(document.querySelector('[data-pane-host="notes/source"] .cm-editor')).toBe(editor)
  expect(session.isConnected).toBe(true)
  expect(session.closest('[inert]')).not.toBeNull()
  f.show('one')
  expect(await screen.findByRole('textbox', { name: 'Session agent:one' })).toBe(session)
  expect(session).toHaveValue('unsent agent input')
  expect(editor.isConnected).toBe(true)
})

test('session retention: open but unseen sessions mount only on first display', async () => {
  const f = sessionFixture()
  act(() =>
    f.store.set(shellWorkspaceAtom, (ws) =>
      selectEntry(openTab(openTab(ws, f.key('one')), f.key('two')), 'A.md'),
    ),
  )
  expect(f.acquired).not.toHaveBeenCalled()
  expect(document.querySelector('[aria-label^="Session "]')).toBeNull()
  f.show('one')
  const first = await screen.findByRole('textbox', { name: 'Session agent:one' })
  f.away()
  expect(first.isConnected).toBe(true)
  expect(f.acquired).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[aria-label="Session agent:two"]')).toBeNull()
  f.show('two')
  await screen.findByRole('textbox', { name: 'Session agent:two' })
  expect(f.acquired).toHaveBeenCalledTimes(2)
})

test('session retention: parking passes visible false and releases keyboard focus', async () => {
  const f = sessionFixture()
  f.show('one')
  const input = await screen.findByRole('textbox', { name: 'Session agent:one' })
  await act(async () => input.focus())
  expect(document.activeElement).toBe(input)
  f.away()
  await waitFor(() => expect(document.activeElement).not.toBe(input))
  expect(input.isConnected).toBe(true)
  expect(input).toHaveAttribute('data-visible', 'false')
  expect(input.closest('[inert]')).not.toBeNull()
  await act(async () => input.focus())
  expect(document.activeElement).not.toBe(input)
  f.show('one')
  expect(await screen.findByRole('textbox', { name: 'Session agent:one' })).toBe(input)
  await act(async () => input.focus())
  expect(document.activeElement).toBe(input)
  expect(input).toHaveAttribute('data-visible', 'true')
})

test('session retention: split and separate reuse both instances regardless of focused member', async () => {
  const f = sessionFixture()
  f.show('one')
  const first = await screen.findByRole('textbox', { name: 'Session agent:one' })
  fireEvent.change(first, { target: { value: 'first local state' } })
  act(() => f.store.set(shellWorkspaceAtom, (ws) => openInSplit(ws, f.key('two'))))
  const second = await screen.findByRole('textbox', { name: 'Session agent:two' })
  fireEvent.change(second, { target: { value: 'second local state' } })
  for (const [id, input] of [
    ['one', first],
    ['two', second],
  ] as const) {
    await act(async () => input.focus())
    expect(focusedTab(f.store.get(shellWorkspaceAtom))).toBe(f.key(id))
    for (const member of [first, second]) {
      expect(member.isConnected).toBe(true)
      expect(member).toHaveAttribute('data-visible', 'true')
      expect(member.closest('[inert]')).toBeNull()
    }
  }
  act(() => f.store.set(shellWorkspaceAtom, (ws) => separate(ws, activeSplit(ws)!.id)))
  expect(first.isConnected).toBe(true)
  expect(second.isConnected).toBe(true)
  expect([first, second].filter((input) => input.dataset.visible === 'true')).toHaveLength(1)
  for (const [id, input, value] of [
    ['one', first, 'first local state'],
    ['two', second, 'second local state'],
  ] as const) {
    f.show(id)
    expect(await screen.findByRole('textbox', { name: `Session agent:${id}` })).toBe(input)
    expect(input).toHaveValue(value)
  }
  expect(f.acquired).toHaveBeenCalledTimes(2)
  expect(f.disposed).not.toHaveBeenCalled()
})

test('session retention: closing a parked session disposes once and reopening starts fresh', async () => {
  const f = sessionFixture()
  f.show('one')
  const first = await screen.findByRole('textbox', { name: 'Session agent:one' })
  const instance = Number(first.dataset.instance)
  fireEvent.change(first, { target: { value: 'discard on close' } })
  f.away()
  expect(f.disposed).not.toHaveBeenCalled()
  act(() => f.store.set(shellWorkspaceAtom, (ws) => closeTab(ws, f.key('one'))))
  expect(first.isConnected).toBe(false)
  expect(f.disposed.mock.calls).toEqual([['agent:one', instance]])
  f.show('one')
  const second = await screen.findByRole('textbox', { name: 'Session agent:one' })
  expect(second).not.toBe(first)
  expect(second.dataset.instance).not.toBe(first.dataset.instance)
  expect(second).toHaveValue('initial')
  expect(f.acquired).toHaveBeenCalledTimes(2)
  cleanup()
  expect(f.disposed.mock.calls).toEqual([
    ['agent:one', instance],
    ['agent:one', Number(second.dataset.instance)],
  ])
})

test('session retention: the same session id in a different vault gets a fresh instance', async () => {
  const f = sessionFixture()
  f.show('one')
  const first = await screen.findByRole('textbox', { name: 'Session agent:one' })
  fireEvent.change(first, { target: { value: 'first vault only' } })
  f.away()
  act(() => f.store.set(activeRemoteAtom, 'mara/other'))
  f.show('one')
  const second = await screen.findByRole('textbox', { name: 'Session agent:one' })
  expect(second).not.toBe(first)
  expect(second.dataset.instance).not.toBe(first.dataset.instance)
  expect(second).toHaveValue('initial')
  expect(first.isConnected).toBe(false)
  expect(f.disposed.mock.calls).toEqual([['agent:one', Number(first.dataset.instance)]])
  expect(f.acquired).toHaveBeenCalledTimes(2)
})

test.each(['mode', 'plugin'])(
  'session retention: removing the %s cleans parked sessions',
  async (removed) => {
    const f = sessionFixture()
    f.show('one')
    const first = await screen.findByRole('textbox', { name: 'Session agent:one' })
    f.away()
    act(() =>
      f.store.set(
        installedPluginsAtom,
        removed === 'plugin' ? [] : [{ ...f.plugin, agentsMode: undefined }],
      ),
    )
    expect(first.isConnected).toBe(false)
    expect(f.disposed.mock.calls).toEqual([['agent:one', Number(first.dataset.instance)]])
    act(() => f.store.set(installedPluginsAtom, [f.plugin]))
    expect(f.acquired).toHaveBeenCalledTimes(1)
    f.show('one')
    expect(await screen.findByRole('textbox', { name: 'Session agent:one' })).not.toBe(first)
    expect(f.acquired).toHaveBeenCalledTimes(2)
  },
)

test.each(['no policy', 'opted out', 'utility', 'home'] as const)(
  'session retention: %s views still unmount when left',
  async (kind) => {
    const f = sessionFixture(kind === 'opted out' ? () => false : undefined)
    if (kind === 'no policy') {
      act(() =>
        f.store.set(installedPluginsAtom, [
          {
            ...f.plugin,
            agentsMode: { ...f.plugin.agentsMode!, keepsSelectionMounted: undefined },
          },
        ]),
      )
    }
    const key =
      kind === 'home'
        ? tabKey({ kind: 'agents-home' })
        : f.key('one', kind === 'utility' ? 'utility' : 'agent')
    const name =
      kind === 'home' ? 'Session home' : `Session ${kind === 'utility' ? 'utility' : 'agent'}:one`
    act(() => f.store.set(shellWorkspaceAtom, (ws) => openTab(ws, key)))
    const first = await screen.findByRole('textbox', { name })
    fireEvent.change(first, { target: { value: 'not retained' } })
    f.away()
    expect(first.isConnected).toBe(false)
    expect(f.disposed).toHaveBeenCalledTimes(1)
    act(() => f.store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, key)))
    const second = await screen.findByRole('textbox', { name })
    expect(second).not.toBe(first)
    expect(second).toHaveValue('initial')
    expect(f.acquired).toHaveBeenCalledTimes(2)
  },
)
