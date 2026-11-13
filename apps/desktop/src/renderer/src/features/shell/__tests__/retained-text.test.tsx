/** Real text editors exercise the shell's connected retention and buffer ownership. */
import { EditorSelection } from '@codemirror/state'
import { undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { getCM, Vim } from '@replit/codemirror-vim'
import { Provider, createStore } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@/test/render'
import { emptyVaultSnapshot, VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { coreContributionAtom } from '@/state/plugins'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '@/state/vaults'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { AGENTS_HOME_KEY } from '@/state/tab-descriptor'
import {
  activeSplit,
  closeTab,
  focusedTab,
  openInSplit,
  openTab,
  selectEntry,
  separate,
} from '@/state/shell-workspace'
import { vimCodeEditingAtom } from '@/state/preferences'
import { changedDocsAtom } from '@/state/doc-changes'
import { editorSelectionAtom } from '@/state/ui-report'
import { flushAllBuffers } from '@/lib/buffer-registry'

const read = vi.fn(
  async (_input: { remote: string; path: string }) => 'first line\nsecond line\nthird line\n',
)
const write = vi.fn(async (_input: unknown) => ({ ok: true, warnings: [] as string[] }))
const files = () =>
  ['src/one.ts', 'src/two.ts', 'notes/one.md', 'settings.json'].map((path) => ({
    path,
    updatedAt: 'one',
  }))
const settings = { ...VAULT_SETTING_DEFAULTS, warnings: [] }

vi.mock('@/lib/trpc', () => {
  const answer = (name: string, input?: unknown): unknown =>
    name === 'notes.read'
      ? read(input as { remote: string; path: string })
      : name === 'settings.read'
        ? settings
        : name === 'settings.pluginFailures'
          ? {}
          : name === 'github.fileContributors' || name === 'history.list'
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
// jsdom has no layout; retain the real shell, routing, editor and history modules.
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
vi.mock('@/features/sidebar/app-sidebar', () => ({ AppSidebar: () => <div /> }))
const { AppShell } = await import('@/features/shell/app-shell')

beforeEach(() => {
  read
    .mockReset()
    .mockImplementation(async ({ path }) =>
      path.endsWith('.json')
        ? '{"initial":true}'
        : path.endsWith('.md')
          ? '# Note\n\nText line\n'
          : 'first line\nsecond line\nthird line\n',
    )
  write.mockReset().mockResolvedValue({ ok: true, warnings: [] })
})
afterEach(() => {
  cleanup()
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
    selectEntry(
      initial.slice(1).reduce((next, key) => openTab(next, key), openTab(ws, initial[0]!)),
      initial[0]!,
    ),
  )
  render(
    <Provider store={store}>
      <AppShell onAddVault={() => {}} />
    </Provider>,
  )
  return store
}
function editor(path = 'src/one.ts') {
  return document.querySelector<HTMLElement>(`[data-file-editor="${path}"] .cm-editor`)
}
async function cmFor(path = 'src/one.ts') {
  await waitFor(() => expect(editor(path)).not.toBeNull())
  return EditorView.findFromDOM(editor(path)!)!
}
function focusTab(store: ReturnType<typeof createStore>, path: string) {
  act(() => store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, path)))
}
function replace(cm: EditorView, text: string) {
  act(() => cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text } }))
}
function diskChanged(store: ReturnType<typeof createStore>, path: string, updatedAt: string) {
  act(() =>
    store.set(snapshotAtom, (snapshot) => ({
      ...snapshot,
      files: snapshot.files.map((file) => (file.path === path ? { ...file, updatedAt } : file)),
    })),
  )
}

// Change-marker reads of unvisited files are existing shared-state work, not editor mounts.
test('markdown document editors remain mounted across tabs and retain editor state', async () => {
  const store = fixture(['notes/one.md', 'src/one.ts'])
  await waitFor(() => expect(document.querySelector('[aria-label="one document"]')).not.toBeNull())
  const editor = document.querySelector('[aria-label="one document"]')!

  focusTab(store, 'src/one.ts')
  await waitFor(() => expect(editor.closest('[data-retained-parking]')).not.toBeNull())
  expect(document.querySelector('[aria-label="one document"]')).toBe(editor)

  focusTab(store, 'notes/one.md')
  await waitFor(() => expect(editor.closest('[data-retained-parking]')).toBeNull())
  expect(document.querySelector('[aria-label="one document"]')).toBe(editor)
})

test('lazy editors retain selection, scroll, undo and Vim through tab and split changes', async () => {
  const store = fixture()
  const one = await cmFor()
  expect(editor('src/two.ts')).toBeNull()
  await waitFor(() => expect(getCM(one)).not.toBeNull())
  const initialReads = read.mock.calls.filter(([input]) => input.path === 'src/one.ts').length
  await act(async () => {
    one.focus()
    Vim.handleKey(getCM(one)!, 'i', 'keydown')
  })
  expect(getCM(one)?.state.vim?.insertMode).toBe(true)
  act(() => {
    one.dispatch({ changes: { from: one.state.doc.length, insert: 'changed' } })
    one.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.range(0, 4), EditorSelection.range(11, 15)],
        1,
      ),
    })
  })
  const selection = one.state.selection.toJSON()
  one.scrollDOM.scrollTop = 420
  one.scrollDOM.scrollLeft = 130
  focusTab(store, 'src/two.ts')
  const two = await cmFor('src/two.ts')
  focusTab(store, 'src/one.ts')
  expect(editor()).toBe(one.dom)
  expect(one.state.selection.toJSON()).toEqual(selection)
  expect(one.scrollDOM.scrollTop).toBe(420)
  expect(one.scrollDOM.scrollLeft).toBe(130)
  expect(getCM(one)?.state.vim?.insertMode).toBe(true)
  expect(read.mock.calls.filter(([input]) => input.path === 'src/one.ts')).toHaveLength(
    initialReads,
  )
  act(() => store.set(shellWorkspaceAtom, (ws) => openInSplit(ws, 'src/two.ts')))
  expect(editor()).toBe(one.dom)
  expect(editor('src/two.ts')).toBe(two.dom)
  await act(async () => one.focus())
  expect(focusedTab(store.get(shellWorkspaceAtom))).toBe('src/one.ts')
  await act(async () => two.focus())
  expect(focusedTab(store.get(shellWorkspaceAtom))).toBe('src/two.ts')
  expect(getCM(one)?.state.vim?.insertMode).toBe(true)
  const split = activeSplit(store.get(shellWorkspaceAtom))!
  act(() => store.set(shellWorkspaceAtom, (ws) => separate(ws, split.id)))
  focusTab(store, 'src/one.ts')
  expect(editor()).toBe(one.dom)
  expect(one.state.selection.toJSON()).toEqual(selection)
  act(() => {
    undo(one)
  })
  expect(one.state.doc.toString()).not.toContain('changed')
})

test('only the focused editor publishes selection and return republishes without a caret move', async () => {
  const store = fixture()
  const one = await cmFor()
  act(() => one.dispatch({ selection: { anchor: 0, head: 12 } }))
  expect(store.get(editorSelectionAtom)?.path).toBe('src/one.ts')
  focusTab(store, 'src/two.ts')
  const two = await cmFor('src/two.ts')
  act(() => two.dispatch({ selection: { anchor: 0, head: 4 } }))
  const foreground = store.get(editorSelectionAtom)
  expect(foreground?.path).toBe('src/two.ts')
  act(() => one.dispatch({ selection: { anchor: 11, head: 15 } }))
  expect(store.get(editorSelectionAtom)).toBe(foreground)
  focusTab(store, 'src/one.ts')
  expect(store.get(editorSelectionAtom)).toEqual({
    path: 'src/one.ts',
    lines: { startLine: 2, endLine: 2 },
  })
})

test('find query and options survive hiding and inactive shortcuts do nothing', async () => {
  const store = fixture()
  const one = await cmFor()
  fireEvent.keyDown(one.contentDOM, { key: 'f', ctrlKey: true })
  const bar = await screen.findByRole('search', { name: 'Find in file' })
  const query = within(bar).getByRole('textbox')
  fireEvent.change(query, { target: { value: 'line' } })
  fireEvent.click(within(bar).getByRole('button', { name: 'Match case' }))
  focusTab(store, 'src/two.ts')
  await cmFor('src/two.ts')
  const before = one.state.selection.toJSON()
  const inactive = new KeyboardEvent('keydown', {
    key: 'g',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })
  act(() => one.contentDOM.dispatchEvent(inactive))
  expect(inactive.defaultPrevented).toBe(false)
  expect(one.state.selection.toJSON()).toEqual(before)
  focusTab(store, 'src/one.ts')
  expect(within(bar).getByRole('textbox')).toBe(query)
  expect(query).toHaveValue('line')
  expect(within(bar).getByRole('button', { name: 'Match case' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('leaving saves immediately and hidden invalid JSON remains flushable through failed close and retry', async () => {
  const store = fixture(['settings.json', 'src/two.ts'])
  const cm = await cmFor('settings.json')
  replace(cm, '{"saved":true}')
  focusTab(store, 'src/two.ts')
  await cmFor('src/two.ts')
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith({
      remote: 'owner/repo',
      path: 'settings.json',
      text: '{"saved":true}',
    }),
  )
  focusTab(store, 'settings.json')
  replace(cm, '{"unfinished":')
  write.mockClear()
  focusTab(store, 'src/two.ts')
  await act(async () => {})
  expect(write).not.toHaveBeenCalled()
  write.mockRejectedValue(new Error('disk full'))
  const close = within(
    document.querySelector('[data-entry-id="settings.json"]') as HTMLElement,
  ).getByRole('button', { name: /^Close / })
  fireEvent.click(close)
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith({
      remote: 'owner/repo',
      path: 'settings.json',
      text: '{"unfinished":',
    }),
  )
  await act(async () => {})
  expect(cm.dom.isConnected).toBe(true)
  expect(cm.state.doc.toString()).toBe('{"unfinished":')
  expect(store.get(shellWorkspaceAtom).entries).toContain('settings.json')
  write.mockResolvedValue({ ok: true, warnings: [] })
  fireEvent.click(close)
  await waitFor(() => expect(cm.dom.isConnected).toBe(false))
  expect(store.get(shellWorkspaceAtom).entries).not.toContain('settings.json')
})

test('clean hidden editors reload and stay Updated until shown; pending local edits win', async () => {
  read.mockResolvedValue('disk one\n')
  const store = fixture()
  const cm = await cmFor()
  focusTab(store, 'src/two.ts')
  await cmFor('src/two.ts')
  read.mockResolvedValue('disk two\n')
  diskChanged(store, 'src/one.ts', 'two')
  await waitFor(() => expect(cm.state.doc.toString()).toBe('disk two\n'))
  expect(editor()).toBe(cm.dom)
  await waitFor(() => expect(store.get(changedDocsAtom).has('src/one.ts')).toBe(true))
  focusTab(store, 'src/one.ts')
  expect(store.get(changedDocsAtom).has('src/one.ts')).toBe(false)
  replace(cm, 'local edit\n')
  const reads = read.mock.calls.length
  read.mockResolvedValue('external three\n')
  diskChanged(store, 'src/one.ts', 'three')
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(reads))
  expect(cm.state.doc.toString()).toBe('local edit\n')
  await act(() => flushAllBuffers())
  expect(write).toHaveBeenCalledWith({
    remote: 'owner/repo',
    path: 'src/one.ts',
    text: 'local edit\n',
  })
})

test('close/reopen rereads and changes in plugin ownership dispose the core editor', async () => {
  const store = fixture(['src/one.ts'])
  const first = await cmFor()
  act(() => store.set(shellWorkspaceAtom, (ws) => closeTab(ws, 'src/one.ts')))
  expect(editor()).toBeNull()
  read.mockResolvedValue('fresh after reopen\n')
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, 'src/one.ts')))
  const second = await cmFor()
  expect(second).not.toBe(first)
  expect(second.state.doc.toString()).toBe('fresh after reopen\n')
  const claim = { match: (path: string) => path === 'src/one.ts', view: () => <p>Plugin owner</p> }
  act(() => store.set(coreContributionAtom, { surfaces: [], rail: [], claims: [claim] }))
  await screen.findByText('Plugin owner')
  expect(second.dom.isConnected).toBe(false)
  act(() => store.set(coreContributionAtom, { surfaces: [], rail: [], claims: [] }))
  expect(await cmFor()).not.toBe(second)
})

test('a new vault owns its same-path editor and ignores a departed pending read', async () => {
  let finishOld!: (text: string) => void
  const pending = new Promise<string>((resolve) => {
    finishOld = resolve
  })
  read.mockImplementation(({ remote, path }) =>
    remote === 'owner/repo' && path === 'src/two.ts'
      ? pending
      : Promise.resolve(`${remote} text\n`),
  )
  const store = fixture()
  const first = await cmFor()
  focusTab(store, 'src/two.ts')
  await screen.findByRole('status', { name: 'Loading file' })
  act(() => {
    store.set(activeRemoteAtom, 'other/repo')
    store.set(snapshotAtom, { ...emptyVaultSnapshot(), files: files() })
    store.set(shellWorkspaceAtom, (ws) => openTab(ws, 'src/one.ts'))
  })
  const second = await cmFor()
  expect(second).not.toBe(first)
  expect(first.dom.isConnected).toBe(false)
  expect(second.state.doc.toString()).toBe('other/repo text\n')
  await act(async () => {
    finishOld('late old vault text\n')
  })
  expect(second.state.doc.toString()).toBe('other/repo text\n')
  expect(document.body).not.toHaveTextContent('late old vault text')
})

test('History closes when its owner is hidden and cannot refocus its parked editor', async () => {
  const store = fixture()
  const one = await cmFor()
  fireEvent.click(
    within(document.querySelector('[data-pane-host="src/one.ts"]') as HTMLElement).getByRole(
      'button',
      { name: 'History' },
    ),
  )
  await screen.findByRole('dialog')
  focusTab(store, 'src/two.ts')
  const two = await cmFor('src/two.ts')
  await act(async () => two.focus())
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(one.dom.contains(document.activeElement)).toBe(false)
  expect(two.dom.contains(document.activeElement)).toBe(true)
})

test('selected line context survives switching to the agent while hidden publications stop', async () => {
  const store = fixture()
  const cm = await cmFor()
  act(() => cm.dispatch({ selection: { anchor: 0, head: 12 } }))
  const context = store.get(editorSelectionAtom)
  expect(context).toEqual({ path: 'src/one.ts', lines: { startLine: 1, endLine: 2 } })
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, AGENTS_HOME_KEY)))
  expect(store.get(editorSelectionAtom)).toBe(context)
  act(() => cm.dispatch({ selection: { anchor: 11, head: 15 } }))
  expect(store.get(editorSelectionAtom)).toBe(context)
})

test('a disk read started before a local save cannot replace that save but later clean reloads work', async () => {
  const store = fixture()
  const cm = await cmFor()
  let finishRead!: (text: string) => void
  const staleRead = new Promise<string>((resolve) => {
    finishRead = resolve
  })
  read.mockImplementation(({ path }) =>
    path === 'src/one.ts' ? staleRead : Promise.resolve('other file\n'),
  )
  const previousReads = read.mock.calls.length
  diskChanged(store, 'src/one.ts', 'before local edit')
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(previousReads))
  replace(cm, 'my final edit')
  focusTab(store, 'src/two.ts')
  await cmFor('src/two.ts')
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith({
      remote: 'owner/repo',
      path: 'src/one.ts',
      text: 'my final edit',
    }),
  )
  await act(async () => {})
  await act(async () => {
    finishRead('stale disk read')
  })
  expect(cm.state.doc.toString()).toBe('my final edit')
  read.mockResolvedValue('new external text after the save')
  diskChanged(store, 'src/one.ts', 'after local save')
  await waitFor(() => expect(cm.state.doc.toString()).toBe('new external text after the save'))
  expect(editor()).toBe(cm.dom)
})
