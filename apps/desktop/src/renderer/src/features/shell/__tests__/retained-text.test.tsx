/** Acceptance tests for real text editors retained by the app shell. */
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Provider, createStore } from 'jotai'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@/test/render'
import { emptyVaultSnapshot, VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { coreContributionAtom } from '@/state/plugins'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '@/state/vaults'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { closeTab, openInSplit, openTab, selectEntry, splitActive } from '@/state/shell-workspace'
import { vimCodeEditingAtom } from '@/state/preferences'

const read = vi.fn(async (_input: { remote: string; path: string }) => 'initial text\n')
const write = vi.fn(async (_input: unknown) => ({ ok: true, warnings: [] }))
const files = () => [
  { path: 'src/one.ts', updatedAt: 'one' },
  { path: 'src/two.ts', updatedAt: 'one' },
  { path: 'settings.json', updatedAt: 'one' },
]
const settings = { ...VAULT_SETTING_DEFAULTS, warnings: [] }

vi.mock('@/lib/trpc', () => {
  const answer = (name: string, input?: unknown): unknown =>
    name === 'notes.read'
      ? read(input as { remote: string; path: string })
      : name === 'settings.read'
        ? settings
        : name === 'settings.pluginFailures'
          ? {}
          : name === 'github.fileContributors'
            ? []
            : name === 'github.collaborators'
              ? { visibility: 'private', collaborators: [] }
              : null
  const procedure = (name: string) => ({
    query: (input?: unknown) => Promise.resolve(answer(name, input)),
    mutate: name === 'notes.write' ? write : async () => ({ ok: true }),
    subscribe: () => ({ unsubscribe() {} }),
  })
  const router = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, key) => (typeof key === 'string' ? procedure(`${name}.${key}`) : undefined),
      },
    )
  return {
    trpc: new Proxy(
      {},
      { get: (_target, key) => (typeof key === 'string' ? router(key) : undefined) },
    ),
  }
})
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}))
vi.mock('@/components/ui/motion-panels', () => ({
  PanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PanelSeparator: () => <div />,
}))
vi.mock('motion-panels/react', () => ({ Separator: () => <div /> }))
vi.mock('@/features/history/file-history-button', () => ({ FileHistoryButton: () => null }))
vi.mock('@/features/sidebar/app-sidebar', () => ({ AppSidebar: () => <div /> }))
const { AppShell } = await import('@/features/shell/app-shell')

afterEach(() => {
  cleanup()
  read.mockClear()
  write.mockClear()
  vi.restoreAllMocks()
})

function fixture(initial = ['src/one.ts', 'src/two.ts']) {
  const store = createStore()
  store.set(activeRemoteAtom, 'owner/repo')
  store.set(vaultsAtom, [
    { remote: 'owner/repo', path: '/vault', name: 'repo', lastOpenedAt: '' },
  ] as never)
  store.set(snapshotAtom, { ...emptyVaultSnapshot(), files: files() })
  store.set(vimCodeEditingAtom, true)
  store.set(shellWorkspaceAtom, (ws) =>
    initial.slice(1).reduce((next, key) => openTab(next, key), openTab(ws, initial[0]!)),
  )
  render(
    <Provider store={store}>
      <AppShell onAddVault={() => {}} />
    </Provider>,
  )
  return store
}
function doc(path = 'src/one.ts') {
  return path
}
function editor(path = 'src/one.ts') {
  const editors = Array.from(document.querySelectorAll<HTMLElement>('.cm-editor'))
  if (path === 'src/two.ts' && editors.length > 1) return editors[1]!
  return editors[0] ?? null
}
async function cmFor(path = 'src/one.ts') {
  await waitFor(() => expect(editor(path)).not.toBeNull())
  return EditorView.findFromDOM(editor(path)!)!
}
function focusTab(store: ReturnType<typeof createStore>, path: string) {
  act(() => store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, doc(path))))
}

test('unvisited code tabs stay lazy; visited editors and complete state survive tab and split transitions', async () => {
  read.mockImplementation(async ({ path }) => `${path} body\n`)
  const store = fixture(['src/one.ts', 'src/two.ts'])
  const one = await cmFor()
  expect(read).toHaveBeenCalledTimes(2)
  expect(
    read.mock.calls.every(
      ([input]) => input.remote === 'owner/repo' && input.path === 'src/one.ts',
    ),
  ).toBe(true)
  expect(editor('src/two.ts')).toBeNull()
  const ranges = [
    { anchor: 2, head: 6 },
    { anchor: 9, head: 12 },
  ]
  one.dispatch({
    selection: EditorSelection.create(
      ranges.map(({ anchor, head }) => EditorSelection.range(anchor, head)),
      1,
    ),
  })
  one.dispatch({ changes: { from: one.state.doc.length, insert: ' changed' } })
  focusTab(store, 'src/two.ts')
  expect(editor()).toBe(one.dom)
  focusTab(store, 'src/one.ts')
  expect(editor()).toBe(one.dom)
  expect(one.state.selection.ranges.map(({ anchor, head }) => ({ anchor, head }))).toEqual(ranges)
  act(() => store.set(shellWorkspaceAtom, (ws) => openInSplit(ws, doc('src/two.ts'))))
  await cmFor('src/two.ts')
  expect(editor()).toBe(one.dom)
  const split = store.get(shellWorkspaceAtom)
  const splitKey = split.active
  act(() => store.set(shellWorkspaceAtom, splitActive))
  expect(editor()).toBe(one.dom)
  expect(store.get(shellWorkspaceAtom).active).toBe(splitKey)
})

test('close and reopen reads a fresh editor; plugin ownership disposes the core view', async () => {
  read.mockResolvedValue('fresh\n')
  const store = fixture(['src/one.ts'])
  const first = await cmFor()
  act(() => store.set(shellWorkspaceAtom, (ws) => closeTab(ws, doc())))
  expect(editor()).toBeNull()
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, doc())))
  const second = await cmFor()
  expect(second).not.toBe(first)
  expect(read).toHaveBeenCalledTimes(2)
  const claim = { match: (path: string) => path === 'src/one.ts', view: () => <p>Plugin owner</p> }
  act(() => store.set(coreContributionAtom, { surfaces: [], rail: [], claims: [claim] }))
  await waitFor(() => expect(screen.getByText('Plugin owner')).toBeTruthy())
  expect(second.dom.isConnected).toBe(false)
  act(() => store.set(coreContributionAtom, { surfaces: [], rail: [], claims: [] }))
  const third = await cmFor()
  expect(third).not.toBe(second)
})

test('hidden clean editor reloads snapshot text without replacing its editor; local edits win', async () => {
  read.mockResolvedValue('disk one\n')
  const store = fixture(['src/one.ts', 'src/two.ts'])
  const cm = await cmFor()
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  focusTab(store, 'src/two.ts')
  read.mockResolvedValue('disk two\n')
  act(() =>
    store.set(snapshotAtom, (snapshot) => ({
      ...snapshot,
      files: snapshot.files.map((file) =>
        file.path === 'src/one.ts' ? { ...file, updatedAt: 'two' } : file,
      ),
    })),
  )
  await waitFor(() => expect(cm.state.doc.toString()).toBe('disk two\n'))
  cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: 'local edit\n' } })
  read.mockResolvedValue('external three\n')
  act(() =>
    store.set(snapshotAtom, (snapshot) => ({
      ...snapshot,
      files: snapshot.files.map((file) =>
        file.path === 'src/one.ts' ? { ...file, updatedAt: 'three' } : file,
      ),
    })),
  )
  await waitFor(() =>
    expect(read).toHaveBeenCalledWith({ remote: 'owner/repo', path: 'src/one.ts' }),
  )
  expect(cm.state.doc.toString()).toBe('local edit\n')
  expect(editor()).toBe(cm.dom)
})
