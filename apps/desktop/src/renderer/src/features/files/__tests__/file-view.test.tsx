/**
 * A non-note file opens in the view its kind wants: a plugin's claim first,
 * an image as an image, an office document as a placeholder, and any other
 * text as code in the plain editor, which saves it, but not while json does
 * not parse; and History, the file's commits, each opening its changes.
 */
import { emptyVaultSnapshot } from '@holi/shared'
import { createStore, Provider } from 'jotai'
import { afterEach, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { act, fireEvent, render, screen, waitFor } from '@/test/render'
import {
  flushAllBuffers,
  freezeBuffers,
  saveAllBuffers,
  saveBuffersOnBlur,
} from '@/lib/buffer-registry'
import { coreContributionAtom } from '@/state/plugins'
import { editorSelectionAtom } from '@/state/ui-report'
import { vimCodeEditingAtom } from '@/state/preferences'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'
import { FileView, isCoreTextFilePath } from '../file-view'
import { HostHintLayer } from '@/features/shell/host-hint-layer'
import { useShortcutDispatcher } from '@/hooks/use-shortcuts'
import { installHintLayout } from '@/test/host-hint-layout'

let lastStore: ReturnType<typeof createStore>
const read = vi.fn()
const write = vi.fn()
const historyList = vi.fn()
const fileDiff = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    notes: {
      read: { query: (input: unknown) => read(input) },
      write: { mutate: (input: unknown) => write(input) },
    },
    github: {
      fileContributors: { query: () => Promise.resolve([]) },
    },
    history: {
      list: { query: (input: unknown) => historyList(input) },
      fileDiff: { query: (input: unknown) => fileDiff(input) },
    },
  },
}))

afterEach(() => {
  read.mockReset()
  write.mockReset()
  historyList.mockReset()
  fileDiff.mockReset()
})

function HintKeys() {
  useShortcutDispatcher()
  return <HostHintLayer scopeKey="fixture:file" />
}

function setup(path: string, claims = false, vimEnabled = false, hints = false) {
  const store = createStore()
  lastStore = store
  store.set(activeRemoteAtom, 'syv-ai/site')
  store.set(vimCodeEditingAtom, vimEnabled)
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    files: [{ path, updatedAt: '2026-10-23T10:00:00Z' }],
  })
  if (claims) {
    store.set(coreContributionAtom, {
      surfaces: [],
      rail: [],
      claims: [
        {
          match: (p: string) => p.endsWith('.pdf'),
          view: ({ path: p }: { path: string }) => <p>Claimed {p}</p>,
        },
      ],
    })
  }
  return render(
    <Provider store={store}>
      <FileView path={path} />
      {hints ? <HintKeys /> : null}
    </Provider>,
  )
}

/** Types into the CodeMirror document, the way a keystroke would land. */
async function typeInto(text: string) {
  const content = await waitFor(() => {
    const node = document.querySelector<HTMLElement>('.cm-content')
    if (node === null) throw new Error('no editor yet')
    return node
  })
  const { EditorView } = await import('@codemirror/view')
  const view = EditorView.findFromDOM(content)!
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  })
}

test('only paths actually routed to the core text editor are retainable', () => {
  const pdfClaim = {
    match: (path: string) => path.endsWith('.pdf'),
    view: () => null,
  }
  const nonViewerClaim = { match: (path: string) => path.endsWith('.custom') }

  expect(isCoreTextFilePath('extensionless', [])).toBe(true)
  expect(isCoreTextFilePath('data.json', [])).toBe(true)
  expect(isCoreTextFilePath('note.md', [])).toBe(false)
  expect(isCoreTextFilePath('photo.png', [])).toBe(false)
  expect(isCoreTextFilePath('archive.docx', [])).toBe(false)
  expect(isCoreTextFilePath('paper.pdf', [pdfClaim])).toBe(false)
  expect(isCoreTextFilePath('item.custom', [nonViewerClaim])).toBe(true)
})

test('an image opens as an image', () => {
  setup('assets/logo.png')
  expect(screen.getByRole('img', { name: 'logo.png' })).toHaveAttribute(
    'src',
    'holi-vault://vault/assets/logo.png',
  )
})

test("a plugin's claim on the path wins", () => {
  setup('docs/brief.pdf', true)
  expect(screen.getByText('Claimed docs/brief.pdf')).toBeInTheDocument()
})

test('an office document is a placeholder, not garbage text', () => {
  setup('plan.docx')
  expect(screen.getByText(/can't show this kind of document/)).toBeInTheDocument()
  expect(read).not.toHaveBeenCalled()
})

test('code opens straight into the editor, with its latest commit', async () => {
  read.mockResolvedValue('body { color: red; }\n')
  historyList.mockResolvedValue([
    {
      sha: '4a14110aaaa',
      subject: 'Update',
      // The history fixture uses the current clock to exercise the relative timestamp.
      date: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      author: 'Ana',
      added: 1,
      removed: 0,
    },
  ])
  setup('styles/site.css')
  await waitFor(() =>
    expect(document.querySelector('.cm-content')).toHaveTextContent('body { color: red; }'),
  )
  expect(document.querySelector('.cm-lineNumbers')).not.toBeNull()
  expect(await screen.findByText('4a14110')).toBeInTheDocument()
  expect(document.querySelector('time')).toBeInTheDocument()
})

test("code wears the code block's colours, Vue included", async () => {
  // CodeMirror measures text ranges, which jsdom does not lay out.
  Range.prototype.getClientRects ??= () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator],
    }) as unknown as DOMRectList
  Range.prototype.getBoundingClientRect ??= () => new DOMRect()
  read.mockResolvedValue('<template>\n  <div class="a">{{ msg }}</div>\n</template>\n')
  historyList.mockResolvedValue([])
  setup('app/Page.vue')
  await waitFor(
    () => {
      const marks = document.querySelectorAll<HTMLElement>('.cm-content .cm-shiki')
      expect(marks.length).toBeGreaterThan(0)
      expect(marks[0]!.getAttribute('style')).toMatch(/--cb-c: ?#[0-9a-f]{6}/i)
    },
    { timeout: 10_000 },
  )
}, 15_000)

test("History lists the commits by day and opens one's changes", async () => {
  read.mockResolvedValue('a\nB\n')
  historyList.mockResolvedValue([
    {
      sha: 'c2ffffffff',
      subject: 'Rename the colour',
      date: '2026-08-05T10:00:00Z',
      author: 'Ana',
      added: 1,
      removed: 1,
    },
  ])
  fileDiff.mockResolvedValue({ before: 'a\nb\n', after: 'a\nB\n' })
  setup('styles/site.css')
  await userEvent.click(await screen.findByRole('button', { name: 'History' }))
  expect(await screen.findByText('Commits on Aug 5, 2026')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /Rename the colour/ }))
  const block = await screen.findByRole('region', {
    name: 'Changes to site.css',
  })
  expect(fileDiff).toHaveBeenCalledWith({ path: 'styles/site.css', sha: 'c2ffffffff' })
  expect(block).toHaveTextContent('ab')
})

test('a file with no commits says so in History', async () => {
  read.mockResolvedValue('x\n')
  historyList.mockResolvedValue([])
  setup('styles/site.css')
  await userEvent.click(await screen.findByRole('button', { name: 'History' }))
  expect(await screen.findByText('No commits yet')).toBeInTheDocument()
})

test('a json file saves once it parses, and not before', async () => {
  read.mockResolvedValue('{"a": 1}\n')
  write.mockResolvedValue(undefined)
  historyList.mockResolvedValue([])
  setup('.holi/config.json', false, true)
  expect(await screen.findByText('Saved')).toBeInTheDocument()

  await typeInto('{"a": ')
  expect(await screen.findByText('Not saved until it parses')).toBeInTheDocument()
  expect(write).not.toHaveBeenCalled()

  await typeInto('{"a": 2}\n')
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith({
      remote: 'syv-ai/site',
      path: '.holi/config.json',
      text: '{"a": 2}\n',
    }),
  )
})

test('flush retries a rejected autosave and propagates persistent failures', async () => {
  read.mockResolvedValue('a\n')
  write.mockResolvedValue(undefined)
  historyList.mockResolvedValue([])
  setup('src/retry.ts', false, true)
  await screen.findByText('Saved')
  await typeInto('b\n')
  write.mockRejectedValueOnce(new Error('offline'))
  await act(() => new Promise((resolve) => setTimeout(resolve, 650)))
  expect(write).toHaveBeenCalledTimes(1)
  write.mockRejectedValueOnce(new Error('still offline'))
  await expect(act(() => flushAllBuffers())).rejects.toThrow('still offline')
  expect(write).toHaveBeenCalledTimes(2)
})

test('a later blur retries a failed autosave while syntax remains valid', async () => {
  read.mockResolvedValue('a\n')
  historyList.mockResolvedValue([])
  write.mockResolvedValue(undefined)
  setup('src/blur.ts', false, true)
  await screen.findByText('Saved')
  await act(() => new Promise((resolve) => setTimeout(resolve, 650)))
  write.mockClear()
  await typeInto('b\n')
  write.mockRejectedValueOnce(new Error('offline'))
  await act(() => new Promise((resolve) => setTimeout(resolve, 650)))
  expect(write).toHaveBeenCalledTimes(1)
  await act(() => saveAllBuffers())
  expect(write).toHaveBeenCalledTimes(2)
  expect(write).toHaveBeenLastCalledWith({
    remote: 'syv-ai/site',
    path: 'src/blur.ts',
    text: 'b\n',
  })
})

test('flush waits for an in-flight autosave and writes edits made while it waits', async () => {
  read.mockResolvedValue('a\n')
  historyList.mockResolvedValue([])
  let release!: () => void
  write.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
  setup('src/race.ts')
  await screen.findByText('Saved')
  // Let the initial async disk read settle before measuring this save.
  await act(() => new Promise((resolve) => setTimeout(resolve, 650)))
  write.mockClear()
  await typeInto('b\n')
  await act(() => new Promise((resolve) => setTimeout(resolve, 650)))
  expect(write).toHaveBeenCalledTimes(1)
  await typeInto('c\n')
  let flushed = false
  const pending = act(async () => {
    await flushAllBuffers()
    flushed = true
  })
  const concurrent = flushAllBuffers()
  expect(flushed).toBe(false)
  release()
  await pending
  await concurrent
  expect(write).toHaveBeenCalledTimes(2)
  expect(write).toHaveBeenLastCalledWith({
    remote: 'syv-ai/site',
    path: 'src/race.ts',
    text: 'c\n',
  })
})

test('closing during a pending Vim-enabled code save retains the final undo snapshot', async () => {
  read.mockResolvedValue('a\n')
  historyList.mockResolvedValue([])
  let release!: () => void
  write.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const view = setup('src/race.ts', false, true)
  await screen.findByText('Saved')
  await typeInto('b\n')
  const first = saveAllBuffers()
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
  await typeInto('a\n')
  const final = flushAllBuffers()
  view.unmount()
  release()
  await first
  await final
  expect(write).toHaveBeenLastCalledWith({
    remote: 'syv-ai/site',
    path: 'src/race.ts',
    text: 'a\n',
  })
})

test('a flush writes a pending edit at once, and a rename after it writes nothing to the old path', async () => {
  read.mockResolvedValue('a\n')
  write.mockResolvedValue(undefined)
  historyList.mockResolvedValue([])
  const view = setup('src/old.ts')
  expect(await screen.findByText('Saved')).toBeInTheDocument()

  await typeInto('b\n')
  // Well inside the save delay, as a rename's flush is.
  await act(() => flushAllBuffers())
  expect(write).toHaveBeenCalledTimes(1)
  expect(write).toHaveBeenLastCalledWith({ remote: 'syv-ai/site', path: 'src/old.ts', text: 'b\n' })

  // The rename moves the file, and the tab follows it to its new path.
  read.mockResolvedValue('b\n')
  view.rerender(
    <Provider store={lastStore}>
      <FileView path="src/new.ts" />
    </Provider>,
  )
  await waitFor(() =>
    expect(document.querySelector('[data-file-editor="src/new.ts"]')).toBeInTheDocument(),
  )
  await act(() => new Promise((resolve) => setTimeout(resolve, 800)))
  expect(write).toHaveBeenCalledTimes(1)
})

test('a flush writes json that does not parse, and ⌘S holds it', async () => {
  read.mockResolvedValue('{"a": 1}\n')
  write.mockResolvedValue(undefined)
  historyList.mockResolvedValue([])
  setup('.holi/config.json', false, true)
  expect(await screen.findByText('Saved')).toBeInTheDocument()

  await typeInto('{"a": ')
  await act(() => saveAllBuffers())
  expect(write).not.toHaveBeenCalled()
  await act(() => flushAllBuffers())
  expect(write).toHaveBeenCalledWith({
    remote: 'syv-ai/site',
    path: '.holi/config.json',
    text: '{"a": ',
  })
})

test('leaving the window saves json that parses, and holds json that does not', async () => {
  read.mockResolvedValue('{"a": 1}\n')
  write.mockResolvedValue(undefined)
  historyList.mockResolvedValue([])
  const off = saveBuffersOnBlur()
  setup('.holi/config.json')
  expect(await screen.findByText('Saved')).toBeInTheDocument()

  await typeInto('{"a": ')
  await act(async () => void fireEvent.blur(window))
  expect(write).not.toHaveBeenCalled()

  await typeInto('{"a": 2}\n')
  await act(async () => void fireEvent.blur(window))
  expect(write).toHaveBeenCalledWith({
    remote: 'syv-ai/site',
    path: '.holi/config.json',
    text: '{"a": 2}\n',
  })
  off()
})

test('Vim key events drive modes, motions, edits, yank, paste, undo and redo', async () => {
  const user = userEvent.setup()
  read.mockResolvedValue('one two\nthree four\n')
  historyList.mockResolvedValue([])
  setup('src/list.txt', false, true)
  const content = await waitFor(() => {
    const node = document.querySelector<HTMLElement>('.cm-content')
    if (node === null) throw new Error('no editor yet')
    return node
  })
  const { EditorView } = await import('@codemirror/view')
  const view = EditorView.findFromDOM(content as HTMLElement)!
  view.focus()
  expect(await screen.findByLabelText('Vim normal mode')).toBeInTheDocument()

  await user.keyboard('i')
  expect(await screen.findByLabelText('Vim insert mode')).toBeInTheDocument()
  await user.keyboard('{Control>}o{/Control}')
  expect(await screen.findByLabelText('Vim normal mode')).toBeInTheDocument()
  await user.keyboard('w')
  expect(await screen.findByLabelText('Vim insert mode')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  view.dispatch({ selection: { anchor: 0 } })
  await user.keyboard('if')
  await user.keyboard('{Escape}')
  await user.keyboard('f')
  expect(view.state.doc.toString()).toBe('fone two\nthree four\n')
  expect(await screen.findByLabelText('Vim normal mode')).toBeInTheDocument()

  await user.keyboard('w')
  expect(view.state.selection.main.head).toBe(5)
  await user.keyboard('vll')
  expect(await screen.findByLabelText('Vim visual mode')).toBeInTheDocument()
  await user.keyboard('y')
  expect(await screen.findByLabelText('Vim normal mode')).toBeInTheDocument()
  await user.keyboard('p')
  const afterPaste = view.state.doc.toString()
  expect(afterPaste).not.toBe('fone two\nthree four\n')
  await user.keyboard('u')
  expect(view.state.doc.toString()).toBe('fone two\nthree four\n')
  await user.keyboard('{Control>}r{/Control}')
  expect(view.state.doc.toString()).toBe(afterPaste)
  await user.keyboard('x')
  expect(view.state.doc.toString()).not.toBe(afterPaste)
  await user.keyboard('u')
  expect(view.state.doc.toString()).toBe(afterPaste)

  view.dispatch({ selection: { anchor: 0 } })
  await user.keyboard('2j')
  expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
})

test('normal Vim f opens host hints without edits; insert and visual mode keep native input', async () => {
  installHintLayout()
  try {
    read.mockResolvedValue('alpha beta\n')
    historyList.mockResolvedValue([])
    const result = setup('src/hints.txt', false, true, true)
    const content = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('.cm-content')
      if (node === null) throw new Error('no editor')
      return node
    })
    const { EditorView } = await import('@codemirror/view')
    const view = EditorView.findFromDOM(content)!
    view.focus()
    await userEvent.keyboard('f')
    expect(screen.getByLabelText('Vim host hints')).toBeInTheDocument()
    expect(view.state.doc.toString()).toBe('alpha beta\n')
    const selection = view.state.selection
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByLabelText('Vim host hints')).not.toBeInTheDocument()
    expect(view.hasFocus).toBe(true)
    expect(view.state.selection.eq(selection)).toBe(true)
    await userEvent.keyboard('if')
    expect(screen.queryByLabelText('Vim host hints')).not.toBeInTheDocument()
    expect(view.state.doc.toString()).toBe('falpha beta\n')
    await userEvent.keyboard('{Escape}vf')
    expect(screen.queryByLabelText('Vim host hints')).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await act(async () => lastStore.set(vimCodeEditingAtom, false))
    await userEvent.keyboard('f')
    expect(screen.queryByLabelText('Vim host hints')).not.toBeInTheDocument()
    expect(view.state.doc.toString()).toContain('ff')
    result.unmount()
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

test('pending Vim commands keep f inside the editor instead of opening host hints', async () => {
  installHintLayout()
  try {
    const user = userEvent.setup()
    read.mockResolvedValue('alpha beta\n')
    historyList.mockResolvedValue([])
    setup('src/pending-vim.txt', false, true, true)
    const content = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('.cm-content')
      if (node === null) throw new Error('no editor')
      return node
    })
    const { EditorView } = await import('@codemirror/view')
    const view = EditorView.findFromDOM(content)!
    content.focus()

    await user.keyboard('df{Escape}w')
    expect(screen.queryByLabelText('Vim host hints')).not.toBeInTheDocument()
    expect(view.state.doc.toString()).toBe('alpha beta\n')

    view.dispatch({ selection: { anchor: 0 } })
    await user.keyboard('rf')
    expect(screen.queryByLabelText('Vim host hints')).not.toBeInTheDocument()
    expect(view.state.doc.toString()).toBe('flpha beta\n')
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

test('changing Vim preference reconfigures the same dirty editor and retains history', async () => {
  const user = userEvent.setup()
  read.mockResolvedValue('alpha beta\n')
  historyList.mockResolvedValue([])
  const result = setup('src/list.txt')
  const content = await waitFor(() => {
    const node = document.querySelector<HTMLElement>('.cm-content')
    if (node === null) throw new Error('no editor yet')
    return node
  })
  const { EditorView } = await import('@codemirror/view')
  const view = EditorView.findFromDOM(content)!
  content.focus()
  await user.keyboard('x')
  const edited = view.state.doc.toString()
  const selection = view.state.selection.main.head
  view.scrollDOM.scrollTop = 31
  act(() => lastStore.set(vimCodeEditingAtom, true))
  await screen.findByLabelText('Vim normal mode')
  expect(EditorView.findFromDOM(content)).toBe(view)
  expect(view.state.doc.toString()).toBe(edited)
  expect(view.state.selection.main.head).toBe(selection)
  await user.keyboard('i!{Escape}')
  const withVimEdit = view.state.doc.toString()
  const vimSelection = view.state.selection.main.head
  act(() => lastStore.set(vimCodeEditingAtom, false))
  await waitFor(() => expect(screen.queryByLabelText(/Vim .* mode/)).toBeNull())
  expect(EditorView.findFromDOM(content)).toBe(view)
  expect(view.state.doc.toString()).toBe(withVimEdit)
  expect(view.state.selection.main.head).toBe(vimSelection)
  expect(view.scrollDOM.scrollTop).toBe(31)
  act(() => lastStore.set(vimCodeEditingAtom, true))
  await screen.findByLabelText('Vim normal mode')
  expect(EditorView.findFromDOM(content)).toBe(view)
  await user.keyboard('u')
  expect(view.state.doc.toString()).toBe(edited)
  expect(result.container.querySelector('[data-file-editor="src/list.txt"]')).toBeInTheDocument()
})

test.each([
  ['Find', false],
  ['Replace', true],
])('normal Vim lets the %s field keep typed f and focus', async (_label, replace) => {
  const user = userEvent.setup()
  read.mockResolvedValue('alpha beta\n')
  historyList.mockResolvedValue([])
  setup('src/find-vim.txt', false, true, true)

  const content = await waitFor(() => {
    const node = document.querySelector<HTMLElement>('.cm-content')
    if (node === null) throw new Error('no editor yet')
    return node
  })
  content.focus()
  await user.keyboard('{Meta>}f{/Meta}')
  const findField = await screen.findByRole('textbox', { name: 'Find' })
  if (replace) {
    await user.click(screen.getByRole('button', { name: 'Show replace' }))
  }
  const field = replace ? screen.getByRole('textbox', { name: 'Replace' }) : findField

  await user.type(field, 'f')
  await user.type(field, 'moretext')

  expect(field).toHaveValue('fmoretext')
  expect(field).toHaveFocus()
  expect(screen.queryByLabelText('Vim host hints')).not.toBeInTheDocument()
})

test.each([
  ['Mac command', '{Meta>}f{/Meta}'],
  ['Control', '{Control>}f{/Control}'],
])(
  '%s finds in a code file, steps through the matches and replaces them',
  async (_platform, shortcut) => {
    const user = userEvent.setup()
    historyList.mockResolvedValue([])
    write.mockResolvedValue({ ok: true })
    read.mockResolvedValue('const a = 1\nconst ab = a + a\n')
    setup('src/main.ts', false, true)
    const content = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('.cm-content')
      if (node === null) throw new Error('no editor yet')
      return node
    })
    content.focus()
    await user.keyboard(shortcut)
    const field = await screen.findByRole('textbox', { name: 'Find' })
    await user.type(field, 'a')
    const status = screen.getByRole('status')
    await waitFor(() => expect(status).toHaveTextContent(/of 4$/))
    await user.click(screen.getByRole('button', { name: 'Match whole word' }))
    await waitFor(() => expect(status).toHaveTextContent('1 of 3'))
    await user.click(field)
    await user.keyboard('{Enter}')
    await waitFor(() => expect(status).toHaveTextContent('2 of 3'))
    expect(document.querySelectorAll('.cm-searchMatch').length).toBe(3)

    await user.click(screen.getByRole('button', { name: 'Show replace' }))
    await user.type(screen.getByRole('textbox', { name: 'Replace' }), 'x')
    await user.click(screen.getByRole('button', { name: 'Replace all' }))
    const { EditorView } = await import('@codemirror/view')
    expect(EditorView.findFromDOM(content)!.state.doc.toString()).toBe(
      'const x = 1\nconst ab = x + x\n',
    )
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('search', { name: 'Find in file' })).toBeNull()
    expect(document.querySelectorAll('.cm-searchMatch').length).toBe(0)
  },
)

test('a code file reports the lines selected in it, and a caret clears them', async () => {
  historyList.mockResolvedValue([])
  read.mockResolvedValue('one\ntwo\nthree\nfour\n')
  setup('src/list.txt')
  const content = await waitFor(() => {
    const node = document.querySelector<HTMLElement>('.cm-content')
    if (node === null) throw new Error('no editor yet')
    return node
  })
  const { EditorView } = await import('@codemirror/view')
  const view = EditorView.findFromDOM(content)!
  // From inside "two" to the start of "four": that line does not count.
  view.dispatch({ selection: { anchor: 5, head: 14 } })
  expect(lastStore.get(editorSelectionAtom)).toEqual({
    path: 'src/list.txt',
    lines: { startLine: 2, endLine: 3 },
  })
  view.dispatch({ selection: { anchor: 2 } })
  expect(lastStore.get(editorSelectionAtom)).toBeNull()
})

test('a code file switched away from and back to keeps its caret', async () => {
  historyList.mockResolvedValue([])
  read.mockResolvedValue('one\ntwo\nthree\nfour\n')
  const first = setup('src/list.txt')
  const { EditorView } = await import('@codemirror/view')
  const find = () =>
    waitFor(() => {
      const node = document.querySelector<HTMLElement>('.cm-content')
      if (node === null) throw new Error('no editor yet')
      return EditorView.findFromDOM(node)!
    })
  ;(await find()).dispatch({ selection: { anchor: 9, head: 12 } })

  // The tab goes, and comes back: a new FileView on the same store.
  first.unmount()
  render(
    <Provider store={lastStore}>
      <FileView path="src/list.txt" />
    </Provider>,
  )
  const back = await find()
  expect(back.state.selection.main.anchor).toBe(9)
  expect(back.state.selection.main.head).toBe(12)
})

test('external updates reload a clean Vim buffer but do not replace a dirty one', async () => {
  read.mockResolvedValueOnce('original\n')
  historyList.mockResolvedValue([])
  setup('src/external.txt', false, true)
  const content = await waitFor(() => {
    const node = document.querySelector<HTMLElement>('.cm-content')
    if (node === null) throw new Error('no editor yet')
    return node
  })
  const { EditorView } = await import('@codemirror/view')
  const view = EditorView.findFromDOM(content)!
  await screen.findByText('Saved')

  read.mockResolvedValueOnce('from disk\n')
  act(() =>
    lastStore.set(snapshotAtom, {
      ...emptyVaultSnapshot(),
      files: [{ path: 'src/external.txt', updatedAt: '2026-10-24T10:00:00Z' }],
    }),
  )
  await waitFor(() => expect(view.state.doc.toString()).toBe('from disk\n'))

  await typeInto('local edit\n')
  read.mockResolvedValueOnce('external conflict\n')
  act(() =>
    lastStore.set(snapshotAtom, {
      ...emptyVaultSnapshot(),
      files: [{ path: 'src/external.txt', updatedAt: '2026-10-25T10:00:00Z' }],
    }),
  )
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3))
  expect(view.state.doc.toString()).toBe('local edit\n')
})

test('Vim commands edit and undo by keyboard, while normal-mode f remains unused', async () => {
  const user = userEvent.setup()
  read.mockResolvedValue('alpha beta gamma\n')
  historyList.mockResolvedValue([])
  setup('src/vim.txt', false, true)
  const content = await waitFor(() => {
    const node = document.querySelector<HTMLElement>('.cm-content')
    if (node === null) throw new Error('no editor yet')
    return node
  })
  const { EditorView } = await import('@codemirror/view')
  const view = EditorView.findFromDOM(content)!
  content!.focus()

  await user.keyboard('2w')
  expect(view.state.selection.main.head).toBe(11)
  await user.keyboard('vll')
  expect(view.state.selection.main.from).toBe(11)
  expect(view.state.selection.main.to).toBe(14)
  await user.keyboard('d')
  const deleted = 'alpha beta ma\n'
  expect(view.state.doc.toString()).toBe(deleted)
  await user.keyboard('u')
  expect(view.state.doc.toString()).toBe('alpha beta gamma\n')
  await user.keyboard('{Control>}r{/Control}')
  expect(view.state.doc.toString()).toBe(deleted)
  await user.keyboard('u')
  expect(view.state.doc.toString()).toBe('alpha beta gamma\n')

  await user.keyboard('i!{Escape}')
  expect(view.state.doc.toString()).toBe('alpha beta !gamma\n')
  await user.keyboard('f')
  expect(view.state.doc.toString()).toBe('alpha beta !gamma\n')
})

test('Vim editing remains isolated to the focused editor', async () => {
  const user = userEvent.setup()
  read.mockResolvedValue('first second\n')
  historyList.mockResolvedValue([])
  setup('src/first.txt', false, true)
  const { EditorView } = await import('@codemirror/view')
  const firstContent = await waitFor(() => {
    const node = document.querySelector<HTMLElement>('.cm-content')
    if (node === null) throw new Error('no editor yet')
    return node
  })
  const first = EditorView.findFromDOM(firstContent)!
  render(
    <Provider store={lastStore}>
      <FileView path="src/second.txt" />
    </Provider>,
  )
  await waitFor(() => expect(document.querySelectorAll('.cm-content')).toHaveLength(2))
  const editors = [...document.querySelectorAll<HTMLElement>('.cm-content')]
  const second = EditorView.findFromDOM(editors[1]!)!
  first.dispatch({ selection: { anchor: 6 } })
  second.dispatch({ selection: { anchor: 0 } })
  editors[1]!.focus()
  await user.keyboard('iX')
  expect(first.state.doc.toString()).toBe('first second\n')
  expect(second.state.doc.toString()).toBe('Xfirst second\n')
  expect(first.state.selection.main.head).toBe(6)
  expect(second.state.selection.main.head).toBe(1)
  expect(screen.getByLabelText('Vim normal mode')).toBeInTheDocument()
  expect(screen.getByLabelText('Vim insert mode')).toBeInTheDocument()
})

test('frozen Vim editors reject edit commands and become editable after thaw', async () => {
  const user = userEvent.setup()
  read.mockResolvedValue('alpha beta\n')
  historyList.mockResolvedValue([])
  setup('src/frozen.txt', false, true)
  expect(await screen.findByLabelText('Vim normal mode')).toBeInTheDocument()
  const content = await waitFor(() => {
    const node = document.querySelector<HTMLElement>('.cm-content')
    if (node === null) throw new Error('no editor yet')
    return node
  })
  const { EditorView } = await import('@codemirror/view')
  const view = EditorView.findFromDOM(content)!
  content.focus()
  const thaw = freezeBuffers()
  expect(content).toHaveAttribute('contenteditable', 'false')
  const deletion = new KeyboardEvent('keydown', {
    key: 'x',
    code: 'KeyX',
    bubbles: true,
    cancelable: true,
  })
  content.dispatchEvent(deletion)
  expect(deletion.defaultPrevented).toBe(true)
  expect(await screen.findByLabelText('Vim normal mode')).toBeInTheDocument()
  expect(view.state.doc.toString()).toBe('alpha beta\n')
  thaw()
  content.focus()
  await user.keyboard('iX{Escape}')
  expect(view.state.doc.toString()).toBe('Xalpha beta\n')
})

test('Vim-off find handling respects keys consumed inside CodeMirror', async () => {
  const user = userEvent.setup()
  read.mockResolvedValue('alpha beta\n')
  historyList.mockResolvedValue([])
  setup('src/find.txt')
  const content = await waitFor(() => {
    const node = document.querySelector<HTMLElement>('.cm-content')
    if (node === null) throw new Error('no editor yet')
    return node
  })
  content.focus()
  await user.keyboard('{Meta>}f{/Meta}')
  expect(await screen.findByRole('textbox', { name: 'Find' })).toBeInTheDocument()
  content.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') event.preventDefault()
  })
  content.focus()
  await user.keyboard('{Escape}')
  expect(screen.getByRole('textbox', { name: 'Find' })).toBeInTheDocument()
})
