/** Real AppShell + Tiptap; only filesystem/agent and layout adapters are replaced. */
import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'
import { setRichTextBubble } from '@/features/documents/rich-text/rich-text-bubble-bar'
import { closeHistory } from '@tiptap/pm/history'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  analyseMermaidLabels,
  emptyVaultSnapshot,
  parseTaskFile,
  TASKS_CLAIM,
  VAULT_SETTING_DEFAULTS,
  type CommentThread,
} from '@holi/shared'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@/test/render'
import { flushAllBuffers, freezeBuffers } from '@/lib/buffer-registry'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '@/state/vaults'
import { installedPluginsAtom } from '@/state/plugins'
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
import { changedDocsAtom } from '@/state/doc-changes'
import { editorSelectionAtom } from '@/state/ui-report'
import { documentRunsAtom, type AgentRun } from '@/state/document-runs'
import { vaultSettingsAtom } from '@/state/settings'
import { sessionAtom } from '@/state/session'
import { pendingHeadingAtom } from '@/state/open-document'

Element.prototype.getAnimations ??= () => []
Range.prototype.getBoundingClientRect ??= () => new DOMRect()
document.elementFromPoint ??= () => null
const ONE = 'notes/one.md'
const TWO = 'notes/two.md'
const REMOTE = 'owner/repo'
const TEXT = '# Note\n\nFirst passage\n\nSecond passage\n'
const disk = new Map<string, string>()
const read = vi.fn(
  async ({ remote, path }: { remote: string; path: string }) =>
    disk.get(`${remote}:${path}`) ?? TEXT,
)
const write = vi.fn(async (_input: { remote: string; path: string; text: string }) => ({
  ok: true,
}))
const capability = vi.fn(async (_input: unknown) => ({ ok: true }))
const comments = vi.fn(async (_input: unknown): Promise<CommentThread[]> => [])
const reply = vi.fn(async (_input: unknown) => ({ ok: true }))
const settings = { ...VAULT_SETTING_DEFAULTS, warnings: [] }
const renderMermaid = vi.hoisted(() => vi.fn())
vi.mock('@/lib/mermaid-renderer', () => ({ renderMermaid }))
vi.mock('@/lib/trpc', () => {
  const answer = (name: string, input?: unknown): unknown =>
    name === 'notes.read'
      ? read(input as { remote: string; path: string })
      : name === 'comments.list'
        ? comments(input)
        : name === 'settings.read'
          ? settings
          : name === 'settings.pluginFailures'
            ? {}
            : name === 'history.list'
              ? [
                  {
                    sha: 'abcdef012345',
                    subject: 'save note',
                    date: '2026-11-01T12:00:00Z',
                    author: 'Ada',
                    added: 1,
                    removed: 0,
                  },
                ]
              : name === 'github.fileContributors' ||
                  name === 'activity.entries' ||
                  name === 'logs.entries' ||
                  name === 'terminal.list'
                ? []
                : name === 'github.collaborators'
                  ? { visibility: 'private', collaborators: [] }
                  : null
  const procedure = (name: string) => ({
    query: (input?: unknown) => Promise.resolve(answer(name, input)),
    mutate:
      name === 'notes.write'
        ? write
        : name === 'cap.run'
          ? capability
          : name === 'comments.reply'
            ? reply
            : async () => ({ ok: true }),
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
vi.mock('@/state/agent-service', async () => {
  const { atom } = await import('jotai')
  const sessions = atom([])
  return {
    useAgentService: () => ({ name: 'Claude', sessions }),
    showAgentSessionAtom: atom(null, () => undefined),
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
vi.mock('@/features/sidebar/app-sidebar', () => ({ AppSidebar: () => <div /> }))
const { AppShell } = await import('@/features/shell/app-shell')

beforeEach(() => {
  disk.clear()
  read
    .mockReset()
    .mockImplementation(async ({ remote, path }) => disk.get(`${remote}:${path}`) ?? TEXT)
  write.mockReset().mockImplementation(async ({ remote, path, text }) => {
    disk.set(`${remote}:${path}`, text)
    return { ok: true }
  })
  comments.mockReset().mockResolvedValue([])
  reply.mockReset().mockResolvedValue({ ok: true })
  capability.mockReset().mockResolvedValue({ ok: true })
  renderMermaid.mockReset().mockImplementation(async (source: string) => {
    const result = analyseMermaidLabels(source)
    const labels = result.supported ? result.labels : []
    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg">${labels.map(({ id, label }) => `<g id="node-${id}"><text>${label}</text></g>`).join('')}</svg>`,
      targets: labels.map(({ id, label }) => ({ id, label, domId: `node-${id}` })),
    }
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function fixture(paths = [ONE, TWO]) {
  const store = createStore()
  store.set(activeRemoteAtom, REMOTE)
  store.set(vaultsAtom, [{ remote: REMOTE, path: '/vault', name: 'repo', lastOpenedAt: '' }])
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    docs: paths.map((path) => ({ path, kind: 'note' as const, updatedAt: 'one' })),
  })
  store.set(vaultSettingsAtom, { remote: REMOTE, settings })
  store.set(shellWorkspaceAtom, (ws) =>
    selectEntry(
      paths.slice(1).reduce((next, path) => openTab(next, path), openTab(ws, paths[0]!)),
      paths[0]!,
    ),
  )
  render(
    <Provider store={store}>
      <AppShell onAddVault={() => {}} />
    </Provider>,
  )
  return store
}
function host(path = ONE) {
  return document.querySelector<HTMLElement>(`[data-pane-host="${path}"]`)!
}
async function editor(path = ONE) {
  await waitFor(() => expect(host(path)?.querySelector('.tiptap')).toBeInstanceOf(HTMLElement))
  await waitFor(() =>
    expect(
      (host(path).querySelector('.tiptap') as HTMLElement & { editor: Editor })?.editor,
    ).toBeTruthy(),
  )
  return (host(path).querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
}
function select(store: ReturnType<typeof createStore>, path: string) {
  act(() => store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, path)))
}
function change(
  store: ReturnType<typeof createStore>,
  path: string,
  text: string,
  updatedAt = text,
) {
  disk.set(`${store.get(activeRemoteAtom)}:${path}`, text)
  act(() =>
    store.set(snapshotAtom, (snapshot) => ({
      ...snapshot,
      docs: snapshot.docs.map((doc) => (doc.path === path ? { ...doc, updatedAt } : doc)),
    })),
  )
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function passage(ed: Editor) {
  let from = 1
  ed.state.doc.descendants((node, pos) => {
    if (node.isText && node.text?.startsWith('First')) from = pos
  })
  act(() => ed.commands.setTextSelection({ from, to: from + 5 }))
}
async function openActions() {
  await userEvent.setup().click(within(host()).getByRole('button', { name: 'Document actions' }))
}
function run(): AgentRun {
  return {
    kind: 'vault-app',
    label: 'App',
    agent: 'Claude',
    provider: 'claude',
    appPath: 'notes/one.app',
    sessionId: 'session',
    status: 'working',
    seenWorking: false,
  }
}

// Editor identity is checked alongside operations that require its real undo/selection history.
test('lazy documents retain edits, undo, selection, scroll and layout through tabs and split/separate', async () => {
  const store = fixture()
  const one = await editor()
  expect(host(TWO)).toBeNull()
  act(() => {
    one.view.dispatch(closeHistory(one.state.tr))
    one.commands.insertContentAt(one.state.doc.content.size - 1, ' appended')
    passage(one)
  })
  const savedSelection = one.state.selection.toJSON()
  const scroll = host().querySelector('.overflow-y-auto')!
  scroll.scrollTop = 360
  await openActions()
  await userEvent.setup().click(screen.getByRole('menuitemcheckbox', { name: 'Full width' }))
  await userEvent.setup().click(screen.getByRole('menuitemcheckbox', { name: 'Small text' }))
  await userEvent.setup().keyboard('{Escape}')
  const page = one.view.dom.parentElement!
  expect(page).toHaveClass('max-w-none', 'text-sm/6')
  const reads = read.mock.calls.filter(([input]) => input.path === ONE).length
  select(store, TWO)
  const two = await editor(TWO)
  await waitFor(() => expect(host(ONE).closest('[data-retained-parking]')).not.toBeNull())
  select(store, ONE)
  expect(await editor()).toBe(one)
  expect(one.state.selection.toJSON()).toEqual(savedSelection)
  expect(scroll.scrollTop).toBe(360)
  expect(page).toHaveClass('max-w-none', 'text-sm/6')
  expect(read.mock.calls.filter(([input]) => input.path === ONE)).toHaveLength(reads)
  act(() => store.set(shellWorkspaceAtom, (ws) => openInSplit(ws, TWO)))
  expect(await editor(TWO)).toBe(two)
  expect(one.isEditable).toBe(true)
  await act(async () => one.view.focus())
  expect(focusedTab(store.get(shellWorkspaceAtom))).toBe(ONE)
  await act(async () => two.view.focus())
  expect(focusedTab(store.get(shellWorkspaceAtom))).toBe(TWO)
  const split = activeSplit(store.get(shellWorkspaceAtom))!
  act(() => store.set(shellWorkspaceAtom, (ws) => separate(ws, split.id)))
  select(store, ONE)
  act(() => one.commands.undo())
  expect(one.getMarkdown()).not.toContain('appended')
})

test('Find query, replace draft and options survive parking, with no autofocus or search movement on return', async () => {
  const store = fixture()
  const one = await editor()
  fireEvent.keyDown(one.view.dom, { key: 'f', ctrlKey: true })
  const bar = await screen.findByRole('search', { name: 'Find in document' })
  const input = within(bar).getByRole('textbox', { name: 'Find' })
  fireEvent.change(input, { target: { value: 'passage' } })
  fireEvent.click(within(bar).getByRole('button', { name: 'Match case' }))
  fireEvent.click(within(bar).getByRole('button', { name: 'Match whole word' }))
  fireEvent.click(within(bar).getByRole('button', { name: 'Use regular expression' }))
  fireEvent.click(within(bar).getByRole('button', { name: 'Show replace' }))
  const replacement = within(bar).getByRole('textbox', { name: 'Replace' })
  fireEvent.change(replacement, { target: { value: 'replacement draft' } })
  const selection = one.state.selection.toJSON()
  select(store, TWO)
  const two = await editor(TWO)
  await act(async () => two.view.focus())
  expect(screen.queryByRole('search', { name: 'Find in document' })).toBeNull()
  const inactive = new KeyboardEvent('keydown', {
    key: 'g',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })
  act(() => one.view.dom.dispatchEvent(inactive))
  expect(inactive.defaultPrevented).toBe(false)
  select(store, ONE)
  expect(within(bar).getByRole('textbox', { name: 'Find' })).toBe(input)
  expect(within(bar).getByRole('textbox', { name: 'Replace' })).toHaveValue('replacement draft')
  expect(input).toHaveValue('passage')
  expect(input).not.toHaveFocus()
  expect(within(bar).getByRole('button', { name: 'Match case' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(within(bar).getByRole('button', { name: 'Match whole word' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(within(bar).getByRole('button', { name: 'Use regular expression' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(one.state.selection.toJSON()).toEqual(selection)
})

test('selection stays available to Agents; background selections do not publish and returning republishes', async () => {
  const store = fixture()
  const one = await editor()
  passage(one)
  await waitFor(() => expect(store.get(editorSelectionAtom)?.path).toBe(ONE))
  const context = store.get(editorSelectionAtom)
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, AGENTS_HOME_KEY)))
  expect(store.get(editorSelectionAtom)).toBe(context)
  act(() => one.commands.setTextSelection(1))
  await new Promise((resolve) => setTimeout(resolve, 280))
  expect(store.get(editorSelectionAtom)).toBe(context)
  select(store, ONE)
  await waitFor(() => expect(store.get(editorSelectionAtom)).toBeNull())
  passage(one)
  await waitFor(() => expect(store.get(editorSelectionAtom)?.path).toBe(ONE))
})

test('displayed unfocused split editors can take focus, edit and find without being disabled', async () => {
  const store = fixture()
  const one = await editor()
  act(() => store.set(shellWorkspaceAtom, (ws) => openInSplit(ws, TWO)))
  const two = await editor(TWO)
  expect(one.view.dom).toHaveAttribute('contenteditable', 'true')
  await act(async () => one.view.focus())
  expect(focusedTab(store.get(shellWorkspaceAtom))).toBe(ONE)
  act(() => one.commands.insertContent('typing into first split'))
  expect(one.getMarkdown()).toContain('typing into first split')
  fireEvent.keyDown(one.view.dom, { key: 'f', ctrlKey: true })
  expect(within(host(ONE)).getByRole('search')).toBeInTheDocument()
  expect(within(host(TWO)).queryByRole('search')).toBeNull()
  await act(async () => two.view.focus())
  expect(screen.queryByRole('search')).toBeNull()
  expect(one.isEditable).toBe(true)
  await userEvent.setup().click(within(host(ONE)).getByRole('button', { name: 'Document actions' }))
  expect(focusedTab(store.get(shellWorkspaceAtom))).toBe(ONE)
  expect(await screen.findByRole('menu')).toBeInTheDocument()
})

test('hidden clean reloads preserve history and Updated clears only when displayed', async () => {
  const store = fixture()
  const one = await editor()
  select(store, TWO)
  await editor(TWO)
  change(store, ONE, TEXT.replace('First', 'External'))
  await waitFor(() => expect(one.getMarkdown()).toContain('External passage'))
  await waitFor(() => expect(store.get(changedDocsAtom).has(ONE)).toBe(true))
  expect(await editor(ONE)).toBe(one)
  select(store, ONE)
  expect(store.get(changedDocsAtom).has(ONE)).toBe(false)
  act(() => one.commands.undo())
  expect(one.getMarkdown()).toContain('External passage')
})

test('a hidden dirty buffer wins over a disk body while saving with the latest disk frontmatter', async () => {
  const pendingWrite = deferred<{ ok: boolean }>()
  write.mockImplementationOnce(() => pendingWrite.promise)
  const store = fixture()
  const one = await editor()
  act(() => one.commands.insertContent('Local edit '))
  select(store, TWO)
  await editor(TWO)
  await waitFor(() => expect(write).toHaveBeenCalled())
  change(store, ONE, '---\npriority: high\n---\n\nExternal body\n')
  await act(async () => {})
  expect(one.getMarkdown()).toContain('Local edit')
  await act(async () => pendingWrite.resolve({ ok: true }))
  await act(() => flushAllBuffers())
  expect(write.mock.calls.at(-1)?.[0].text).toContain('Local edit')
  expect(write.mock.calls.at(-1)?.[0].text).toContain('priority: high')
})

test('tidy-only hidden updates leave the typed whitespace, selection and undo stack untouched', async () => {
  const store = fixture()
  const one = await editor()
  act(() => one.commands.insertContent('local '))
  await act(() => flushAllBuffers())
  const text = write.mock.calls.at(-1)![0].text
  const selection = one.state.selection.toJSON()
  select(store, TWO)
  await editor(TWO)
  change(store, ONE, `${text.trimEnd()}\n`)
  await act(async () => {})
  expect(one.state.selection.toJSON()).toEqual(selection)
  expect(one.getMarkdown()).toContain('local ')
  select(store, ONE)
  act(() => one.commands.undo())
  expect(one.getMarkdown()).not.toContain('local ')
})

test('pending saves serialize; failed destructive close retains the hidden dirty editor and Retry saves it', async () => {
  const store = fixture()
  const one = await editor()
  const pending = deferred<{ ok: boolean }>()
  write.mockImplementationOnce(() => pending.promise)
  act(() => one.commands.insertContent('first '))
  select(store, TWO)
  await editor(TWO)
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
  select(store, ONE)
  act(() => one.commands.insertContent('newest '))
  select(store, TWO)
  expect(write).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve({ ok: true }))
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
  expect(write.mock.calls[1]![0].text).toContain('newest')
  select(store, ONE)
  act(() => one.commands.insertContent('unsaved '))
  write.mockRejectedValue(new Error('disk full'))
  select(store, TWO)
  const close = within(
    document.querySelector('[data-entry-id="notes/one.md"]') as HTMLElement,
  ).getByRole('button', { name: /^Close / })
  fireEvent.click(close)
  await waitFor(() => expect(write.mock.calls.at(-1)?.[0].text).toContain('unsaved'))
  await act(async () => {})
  expect(one.isDestroyed).toBe(false)
  expect(store.get(shellWorkspaceAtom).entries).toContain(ONE)
  write.mockImplementation(async ({ remote, path, text }) => {
    disk.set(`${remote}:${path}`, text)
    return { ok: true }
  })
  fireEvent.click(close)
  await waitFor(() => expect(one.isDestroyed).toBe(true))
  expect(store.get(shellWorkspaceAtom).entries).not.toContain(ONE)
})

test('hidden frozen editors stay noneditable after release; reloads still apply during a freeze', async () => {
  const store = fixture()
  const one = await editor()
  select(store, TWO)
  await editor(TWO)
  let release!: () => void
  act(() => {
    release = freezeBuffers()
  })
  change(store, ONE, '# Incoming while frozen\n')
  await waitFor(() => expect(one.getMarkdown()).toContain('Incoming while frozen'))
  act(release)
  expect(one.isEditable).toBe(false)
  select(store, ONE)
  expect(one.isEditable).toBe(true)
})

test('close/reopen makes a fresh editor and same-path vault switches discard no pending old-vault read into it', async () => {
  const store = fixture()
  const one = await editor()
  act(() => store.set(shellWorkspaceAtom, (ws) => closeTab(ws, ONE)))
  await waitFor(() => expect(one.isDestroyed).toBe(true))
  disk.set(`${REMOTE}:${ONE}`, '# Reopened from disk\n')
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, ONE)))
  const reopened = await editor()
  expect(reopened).not.toBe(one)
  expect(reopened.getMarkdown()).toContain('Reopened from disk')
  const oldRead = deferred<string>()
  read.mockImplementation(({ remote, path }) =>
    remote === REMOTE && path === TWO ? oldRead.promise : Promise.resolve(`${remote} fresh text`),
  )
  select(store, TWO)
  act(() => {
    store.set(activeRemoteAtom, 'other/repo')
    store.set(shellWorkspaceAtom, (ws) => openTab(ws, ONE))
  })
  const other = await editor()
  expect(other).not.toBe(reopened)
  await waitFor(() => expect(reopened.isDestroyed).toBe(true))
  expect(other.getMarkdown()).toContain('other/repo fresh text')
  await act(async () => oldRead.resolve('stale old vault body'))
  expect(other.getMarkdown()).not.toContain('stale')
})

test('History, document actions and image body portals disappear on leave without restoring parked focus', async () => {
  disk.set(`${REMOTE}:${ONE}`, `${TEXT}\n![Picture](image.png)\n`)
  const store = fixture()
  const one = await editor()
  fireEvent.click(within(host()).getByRole('button', { name: 'History' }))
  await screen.findByRole('dialog')
  await userEvent.setup().click(await screen.findByRole('combobox', { name: 'Time' }))
  expect(await screen.findByRole('listbox')).toBeInTheDocument()
  select(store, TWO)
  const two = await editor(TWO)
  await act(async () => two.view.focus())
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  select(store, ONE)
  await openActions()
  await screen.findByRole('menu')
  select(store, TWO)
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  select(store, ONE)
  fireEvent.doubleClick(within(host()).getByAltText('Picture'))
  await screen.findByRole('dialog', { name: 'Picture' })
  select(store, TWO)
  await act(async () => two.view.focus())
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(one.view.dom).not.toHaveFocus()
  select(store, ONE)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('menu')).toBeNull()
})

test('comment and reply drafts survive leaving, and mention completion frames cannot steal focus after return', async () => {
  comments.mockResolvedValue([
    {
      id: 'thread',
      anchor: { quote: 'First passage', prefix: '', suffix: '', line: 3 },
      comments: [
        { id: 'comment', author: 'ada', at: '2026-11-01T00:00:00Z', body: 'Existing comment' },
      ],
      status: null,
    },
  ])
  const store = fixture()
  act(() => store.set(sessionAtom, { login: 'ada' } as never))
  const one = await editor()
  passage(one)
  fireEvent.keyDown(one.view.dom, { key: 'm', code: 'KeyM', ctrlKey: true, altKey: true })
  const draft = await screen.findByRole('combobox', { name: 'Comment' })
  fireEvent.change(draft, { target: { value: 'draft @a', selectionStart: 8 } })
  fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
  const replyBox = await screen.findByRole('combobox', { name: 'Reply' })
  fireEvent.change(replyBox, { target: { value: 'reply draft' } })
  select(store, TWO)
  const two = await editor(TWO)
  await act(async () => two.view.focus())
  expect(screen.queryByRole('listbox', { name: 'Mention' })).toBeNull()
  select(store, ONE)
  expect(screen.getByRole('combobox', { name: 'Comment' })).toBe(draft)
  expect(draft).toHaveValue('draft @a')
  expect(replyBox).toHaveValue('reply draft')
  expect(replyBox).not.toHaveFocus()
  await act(async () => (draft as HTMLTextAreaElement).focus())
  fireEvent.change(draft, { target: { value: 'draft @a', selectionStart: 8 } })
  const option = await screen.findByRole('option', { name: /ada$/ })
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  fireEvent.mouseDown(option)
  select(store, TWO)
  await act(async () => two.view.focus())
  select(store, ONE)
  act(() => frames.forEach((frame) => frame(0)))
  expect(draft).not.toHaveFocus()
  expect(draft).toHaveValue('draft @ada ')
})

test('inline agent prompt draft stays mounted and returning never autofocuses it', async () => {
  const store = fixture()
  const one = await editor()
  act(() => one.commands.insertContentAt(one.state.doc.content.size, { type: 'paragraph' }))
  act(() => one.commands.setTextSelection(one.state.doc.content.size - 1))
  fireEvent.keyDown(one.view.dom, { key: ' ', code: 'Space' })
  // No agent plugin is installed in this fixture; install the seam before retrying.
  act(() =>
    store.set(installedPluginsAtom, [
      { info: { id: 'stand-in', label: 'Stand-in', default: true }, agent: { name: 'Claude' } },
    ] as never),
  )
  fireEvent.keyDown(one.view.dom, { key: ' ', code: 'Space' })
  const prompt = await screen.findByRole('textbox', { name: 'What should the agent do?' })
  fireEvent.change(prompt, { target: { value: 'unfinished instruction' } })
  select(store, TWO)
  const two = await editor(TWO)
  await act(async () => two.view.focus())
  expect(screen.queryByRole('textbox', { name: 'What should the agent do?' })).toBeNull()
  select(store, ONE)
  expect(screen.getByRole('textbox', { name: 'What should the agent do?' })).toBe(prompt)
  expect(prompt).toHaveValue('unfinished instruction')
  expect(prompt).not.toHaveFocus()
})

test('queued Tiptap focus and pending heading frames expire on leaving, even if returning before the frame', async () => {
  const store = fixture()
  const one = await editor()
  select(store, TWO)
  const two = await editor(TWO)
  await act(async () => two.view.focus())
  select(store, ONE)
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  act(() => store.set(pendingHeadingAtom, { path: ONE, heading: 'note' }))
  expect(store.get(pendingHeadingAtom)).toBeNull()
  expect(frames.length).toBeGreaterThan(0)
  select(store, TWO)
  await act(async () => two.view.focus())
  select(store, ONE)
  const scroll = vi.spyOn(one.commands, 'scrollIntoView')
  act(() => frames.forEach((frame) => frame(0)))
  expect(one.view.dom).not.toHaveFocus()
  expect(scroll).not.toHaveBeenCalled()
})

test.each(['leave-and-return', 'close-and-reopen'] as const)(
  'agent completion after %s offers Open but never navigates',
  async (transition) => {
    const store = fixture()
    const one = await editor()
    act(() => store.set(documentRunsAtom, { [ONE]: run() }))
    if (transition === 'leave-and-return') {
      select(store, TWO)
      await editor(TWO)
      select(store, ONE)
    } else {
      act(() => store.set(shellWorkspaceAtom, (ws) => closeTab(ws, ONE)))
      act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, ONE)))
      await editor()
    }
    expect(store.get(documentRunsAtom)[ONE]?.away).toBe(true)
    act(() =>
      store.set(documentRunsAtom, (runs) => ({
        ...runs,
        [ONE]: { ...runs[ONE]!, status: 'done' },
      })),
    )
    await screen.findByRole('button', { name: 'Open' })
    expect(focusedTab(store.get(shellWorkspaceAtom))).toBe(ONE)
    expect(store.get(documentRunsAtom)[ONE]?.opened).not.toBe(true)
    if (transition === 'leave-and-return') expect(await editor()).toBe(one)
  },
)

test('Mermaid label draft survives parking and validation cannot apply or refocus after leaving and returning', async () => {
  disk.set(
    `${REMOTE}:${ONE}`,
    `${TEXT}\n\`\`\`mermaid\nflowchart LR\nA[Alpha] --> B[Beta]\n\`\`\`\n`,
  )
  const store = fixture()
  const one = await editor()
  fireEvent.click(await screen.findByRole('button', { name: 'Edit labels' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Alpha' }))
  fireEvent.change(await screen.findByRole('textbox', { name: 'Alpha' }), {
    target: { value: 'Gamma' },
  })
  const validation = deferred<{
    svg: string
    targets: { id: string; label: string; domId: string }[]
  }>()
  renderMermaid.mockImplementationOnce(() => validation.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  select(store, TWO)
  const two = await editor(TWO)
  await act(async () => two.view.focus())
  expect(screen.queryByRole('textbox', { name: 'Alpha' })).toBeNull()
  select(store, ONE)
  await act(async () =>
    validation.resolve({
      svg: '<svg/>',
      targets: [
        { id: 'A', label: 'Gamma', domId: 'node-A' },
        { id: 'B', label: 'Beta', domId: 'node-B' },
      ],
    }),
  )
  expect(one.getMarkdown()).toContain('A[Alpha]')
  expect(one.view.dom).not.toHaveFocus()
  fireEvent.click(await screen.findByRole('button', { name: 'Alpha' }))
  expect(await screen.findByRole('textbox', { name: 'Alpha' })).toHaveValue('Gamma')
})

test('link address and custom agent instruction drafts survive their portals closing on leave', async () => {
  const store = fixture()
  const one = await editor()
  passage(one)
  fireEvent.keyDown(one.view.dom, { key: 'k', ctrlKey: true })
  const address = await screen.findByRole('textbox', { name: 'Link address' })
  fireEvent.change(address, { target: { value: 'unfinished.example/path' } })
  select(store, TWO)
  const two = await editor(TWO)
  await act(async () => two.view.focus())
  expect(screen.queryByRole('textbox', { name: 'Link address' })).toBeNull()
  select(store, ONE)
  expect(screen.queryByRole('textbox', { name: 'Link address' })).toBeNull()
  fireEvent.keyDown(one.view.dom, { key: 'k', ctrlKey: true })
  expect(await screen.findByRole('textbox', { name: 'Link address' })).toHaveValue(
    'unfinished.example/path',
  )
  await userEvent.setup().keyboard('{Escape}')
  passage(one)
  act(() => setRichTextBubble(one, 'documentFormatBubble', 'show'))
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Ask AI' }))
  await userEvent
    .setup()
    .click(await screen.findByRole('menuitem', { name: 'Custom instruction…' }))
  const custom = await screen.findByRole('textbox', { name: 'What should the agent do?' })
  fireEvent.change(custom, { target: { value: 'selection instruction draft' } })
  select(store, TWO)
  await act(async () => two.view.focus())
  expect(screen.queryByRole('textbox', { name: 'What should the agent do?' })).toBeNull()
  select(store, ONE)
  expect(screen.queryByRole('textbox', { name: 'What should the agent do?' })).toBeNull()
  act(() => setRichTextBubble(one, 'documentFormatBubble', 'show'))
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Ask AI' }))
  await userEvent
    .setup()
    .click(await screen.findByRole('menuitem', { name: 'Custom instruction…' }))
  expect(await screen.findByRole('textbox', { name: 'What should the agent do?' })).toHaveValue(
    'selection instruction draft',
  )
})

test('slash suggestion body portal is removed on leave and its delayed lookup cannot resurrect it', async () => {
  const store = fixture()
  const one = await editor()
  act(() => {
    one.view.focus()
    one.commands.insertContentAt(one.state.doc.content.size, { type: 'paragraph' })
    one.commands.setTextSelection(one.state.doc.content.size - 1)
    one.commands.insertContent('/')
  })
  await screen.findByRole('listbox', { name: 'Insert block' })
  select(store, TWO)
  const two = await editor(TWO)
  await act(async () => two.view.focus())
  await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Insert block' })).toBeNull())
  select(store, ONE)
  expect(screen.queryByRole('listbox', { name: 'Insert block' })).toBeNull()
  expect(one.getMarkdown()).toContain('/')
})

test('table confirmation and its toast Undo belong to the visit that opened them', async () => {
  const store = fixture()
  const one = await editor()
  act(() => {
    one.view.focus()
    one.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })
    setRichTextBubble(one, 'richTextTableBubble', 'show')
  })
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Delete' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Delete Table' }))
  await screen.findByRole('alertdialog', { name: 'Delete Table?' })
  select(store, TWO)
  const two = await editor(TWO)
  await act(async () => two.view.focus())
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(one.view.dom.querySelector('table')).not.toBeNull()
  select(store, ONE)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  act(() => {
    one.view.focus()
    setRichTextBubble(one, 'richTextTableBubble', 'show')
  })
  await user.click(await screen.findByRole('button', { name: 'Delete' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Delete Table' }))
  const success = vi.spyOn(toast, 'success')
  await user.click(await screen.findByRole('button', { name: 'Delete Table' }))
  expect(one.view.dom.querySelector('table')).toBeNull()
  const undo = success.mock.calls.find(([message]) => message === 'Table deleted')?.[1]?.action
  expect(undo).toBeTruthy()
  select(store, TWO)
  await act(async () => two.view.focus())
  select(store, ONE)
  act(() => {
    if (undo && typeof undo === 'object' && 'onClick' in undo) undo.onClick({} as never)
  })
  expect(one.view.dom.querySelector('table')).toBeNull()
  expect(one.view.dom).not.toHaveFocus()
})

test('task field portals close in the background and their project, label and estimate drafts survive reopening', async () => {
  const taskPath = 'tasks/task.work.md'
  const taskText = '---\nstatus: todo\n---\n\n# Work\n\nTask body\n'
  disk.set(`${REMOTE}:${taskPath}`, taskText)
  const store = fixture([taskPath, TWO])
  act(() =>
    store.set(snapshotAtom, (snapshot) => ({
      ...snapshot,
      claimed: { [TASKS_CLAIM]: { items: [parseTaskFile(taskText, taskPath)], broken: [] } },
    })),
  )
  const task = await editor(taskPath)
  const user = userEvent.setup()
  const project = within(host(taskPath)).getByRole('button', { name: 'Project: tasks' })
  await user.click(project)
  const query = await screen.findByPlaceholderText('Find or name a project…')
  fireEvent.change(query, { target: { value: 'unfinished project' } })
  select(store, TWO)
  const two = await editor(TWO)
  await act(async () => two.view.focus())
  expect(screen.queryByPlaceholderText('Find or name a project…')).toBeNull()
  select(store, taskPath)
  expect(screen.queryByPlaceholderText('Find or name a project…')).toBeNull()
  await user.click(project)
  expect(await screen.findByPlaceholderText('Find or name a project…')).toHaveValue(
    'unfinished project',
  )
  await user.keyboard('{Escape}')
  await user.click(within(host(taskPath)).getByRole('button', { name: 'Labels' }))
  fireEvent.change(await screen.findByPlaceholderText('Find or add a label…'), {
    target: { value: 'unfinished label' },
  })
  select(store, TWO)
  await act(async () => two.view.focus())
  select(store, taskPath)
  await user.click(within(host(taskPath)).getByRole('button', { name: 'Labels' }))
  expect(await screen.findByPlaceholderText('Find or add a label…')).toHaveValue('unfinished label')
  await user.keyboard('{Escape}')
  await user.click(within(host(taskPath)).getByRole('button', { name: 'Estimate' }))
  fireEvent.change(await screen.findByRole('textbox', { name: 'Estimate' }), {
    target: { value: '1.' },
  })
  select(store, TWO)
  await act(async () => two.view.focus())
  select(store, taskPath)
  expect(screen.queryByRole('textbox', { name: 'Estimate' })).toBeNull()
  await user.click(within(host(taskPath)).getByRole('button', { name: 'Estimate' }))
  expect(await screen.findByRole('textbox', { name: 'Estimate' })).toHaveValue('1.')
  expect(task.getMarkdown()).toContain('Task body')
})

test('Done awaiting a save never closes a task after leaving and returning', async () => {
  const taskPath = 'tasks/task.work.md'
  const store = fixture([taskPath, TWO])
  const task = await editor(taskPath)
  act(() => task.commands.insertContent('pending edit'))
  const pending = deferred<{ ok: boolean }>()
  write.mockImplementationOnce(() => pending.promise)
  fireEvent.click(within(host(taskPath)).getByRole('button', { name: 'Done' }))
  await waitFor(() => expect(write).toHaveBeenCalled())
  select(store, TWO)
  await editor(TWO)
  select(store, taskPath)
  await act(async () => pending.resolve({ ok: true }))
  expect(store.get(shellWorkspaceAtom).entries).toContain(taskPath)
  expect(task.isDestroyed).toBe(false)
  expect(task.isEditable).toBe(true)
})

test('a comment request awaiting save cannot open a draft after leaving and returning', async () => {
  const store = fixture()
  const one = await editor()
  act(() => one.commands.insertContent('local '))
  passage(one)
  const pending = deferred<{ ok: boolean }>()
  write.mockImplementationOnce(() => pending.promise)
  fireEvent.keyDown(one.view.dom, { key: 'm', code: 'KeyM', ctrlKey: true, altKey: true })
  await waitFor(() => expect(write).toHaveBeenCalled())
  select(store, TWO)
  const two = await editor(TWO)
  await act(async () => two.view.focus())
  select(store, ONE)
  await act(async () => pending.resolve({ ok: true }))
  expect(screen.queryByRole('combobox', { name: 'Comment' })).toBeNull()
  expect(one.view.dom).not.toHaveFocus()
})

test('a submitted app request survives its pending save, but its original visit cannot navigate on completion', async () => {
  const store = fixture()
  act(() =>
    store.set(installedPluginsAtom, [
      { info: { id: 'stand-in', label: 'Stand-in', default: true }, agent: { name: 'Claude' } },
    ] as never),
  )
  const one = await editor()
  act(() => one.commands.insertContent('local '))
  const pending = deferred<{ ok: boolean }>()
  write.mockImplementationOnce(() => pending.promise)
  await openActions()
  await userEvent.setup().click(await screen.findByRole('menuitem', { name: 'Create vault app' }))
  await waitFor(() => expect(write).toHaveBeenCalled())
  select(store, TWO)
  const two = await editor(TWO)
  await act(async () => two.view.focus())
  select(store, ONE)
  await act(async () => pending.resolve({ ok: true }))
  await waitFor(() =>
    expect(capability).toHaveBeenCalledWith(expect.objectContaining({ name: 'agent.scoped' })),
  )
  expect(store.get(documentRunsAtom)[ONE]?.away).toBe(true)
  act(() =>
    store.set(documentRunsAtom, (runs) => ({ ...runs, [ONE]: { ...runs[ONE]!, status: 'done' } })),
  )
  expect(await screen.findByRole('button', { name: 'Open' })).toBeInTheDocument()
  expect(focusedTab(store.get(shellWorkspaceAtom))).toBe(ONE)
  expect(one.view.dom).not.toHaveFocus()
})

test('editing an existing link initializes its address, while a different passage never inherits an old draft', async () => {
  disk.set(
    `${REMOTE}:${ONE}`,
    '# Note\n\n[First passage](https://first.example) and [Second passage](https://second.example)\n',
  )
  fixture()
  const one = await editor()
  passage(one)
  fireEvent.keyDown(one.view.dom, { key: 'k', ctrlKey: true })
  expect(await screen.findByRole('textbox', { name: 'Link address' })).toHaveValue(
    'https://first.example',
  )
  fireEvent.change(screen.getByRole('textbox', { name: 'Link address' }), {
    target: { value: 'unfinished first draft' },
  })
  await userEvent.setup().keyboard('{Escape}')
  let at = 1
  one.state.doc.descendants((node, pos) => {
    if (node.isText && node.text?.startsWith('Second')) at = pos
  })
  act(() => one.commands.setTextSelection(at + 1))
  fireEvent.keyDown(one.view.dom, { key: 'k', ctrlKey: true })
  expect(await screen.findByRole('textbox', { name: 'Link address' })).toHaveValue(
    'https://second.example',
  )
})

test('completion batched with leaving cannot navigate when the document is subsequently displayed', async () => {
  const store = fixture()
  await editor()
  act(() => store.set(documentRunsAtom, { [ONE]: run() }))
  act(() => {
    store.set(documentRunsAtom, (runs) => ({ ...runs, [ONE]: { ...runs[ONE]!, status: 'done' } }))
    store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, TWO))
  })
  await editor(TWO)
  select(store, ONE)
  expect(await screen.findByRole('button', { name: 'Open' })).toBeInTheDocument()
  expect(focusedTab(store.get(shellWorkspaceAtom))).toBe(ONE)
  expect(store.get(documentRunsAtom)[ONE]?.away).toBe(true)
})

test('a link bubble in a still-displayed split disappears when the other document owns focus', async () => {
  disk.set(`${REMOTE}:${ONE}`, '# Note\n\n[First passage](https://first.example)\n')
  const store = fixture()
  const one = await editor()
  passage(one)
  await act(async () => one.view.focus())
  act(() => setRichTextBubble(one, 'richTextLinkBubble', 'show'))
  expect(await screen.findByRole('link', { name: /first.example/ })).toBeInTheDocument()
  act(() => store.set(shellWorkspaceAtom, (ws) => openInSplit(ws, TWO)))
  const two = await editor(TWO)
  await act(async () => two.view.focus())
  expect(one.isEditable).toBe(true)
  expect(screen.queryByRole('link', { name: /first.example/ })).toBeNull()
  expect(two.view.dom).toHaveFocus()
})
