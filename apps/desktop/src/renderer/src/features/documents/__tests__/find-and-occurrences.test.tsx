/**
 * Find in a document (⌘F, Ctrl+F here: jsdom is not a Mac) and ⌘D's next
 * occurrence, in the real document view against a mocked vault: the bar
 * opens seeded from the selection and counts, Enter and ⇧Enter step, Escape
 * hands the match back to the editor, the toggles change what matches, ⌘D
 * selects a word and then adds occurrences that typing edits together, and
 * duplicate block has moved to ⇧⌥↓.
 */
import { emptyVaultSnapshot } from '@holi/shared'
import userEvent from '@testing-library/user-event'
import type { Editor } from '@tiptap/react'
import { createStore, Provider } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'

import { act, fireEvent, render, screen, waitFor } from '@/test/render'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'

import { DocumentView } from '../document-view'
import { extraSelections } from '../multi-cursor'

Element.prototype.getAnimations ??= () => []
// ProseMirror measures the caret; jsdom has no layout.
Range.prototype.getBoundingClientRect ??= () => new DOMRect()
Range.prototype.getClientRects ??= () =>
  ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList
Element.prototype.scrollIntoView ??= () => undefined
document.elementFromPoint ??= () => null

const files = new Map<string, string>()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    notes: {
      read: {
        query: ({ path }: { path: string }) => Promise.resolve(files.get(path) ?? ''),
      },
      write: {
        mutate: (input: { path: string; text: string }) => {
          files.set(input.path, input.text)
          return Promise.resolve({ ok: true })
        },
      },
    },
    history: { list: { query: () => Promise.resolve([]) } },
    github: { fileContributors: { query: () => Promise.resolve([]) } },
    cap: { run: { mutate: () => Promise.resolve({ ok: true }) } },
  },
}))

vi.mock('@/state/agent-service', async () => {
  const { atom } = await import('jotai')
  return {
    useAgentService: () => null,
    showAgentSessionAtom: atom(null, () => undefined),
    __sessions: atom([]),
  }
})

const PATH = 'notes/Plan.md'
let store: ReturnType<typeof createStore>

beforeEach(() => {
  files.clear()
  store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    docs: [{ path: PATH, kind: 'note', updatedAt: '2026-10-23T10:00:00Z' }],
  } as never)
})

async function open(text: string) {
  files.set(PATH, text)
  render(
    <Provider store={store}>
      <DocumentView path={PATH} onOpen={() => undefined} />
    </Provider>,
  )
  const box = await screen.findByRole('textbox', { name: 'Plan document' })
  // Tiptap hangs the editor on its element.
  const editor = (box as HTMLElement & { editor: Editor }).editor
  box.focus()
  return { box, editor }
}

const selected = (editor: Editor) => {
  const { from, to } = editor.state.selection
  return editor.state.doc.textBetween(from, to)
}

const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(target, { key, ...init })

test('Ctrl+F opens the bar seeded from the selection, with the count', async () => {
  const { box, editor } = await open('alpha beta alpha gamma Alpha\n')
  act(() => {
    editor.commands.setTextSelection({ from: 1, to: 6 })
  })
  expect(press(box, 'f', { ctrlKey: true })).toBe(false)

  const field = await screen.findByRole('textbox', { name: 'Find' })
  expect(field).toHaveValue('alpha')
  await waitFor(() => expect(field).toHaveFocus())
  // Case-insensitive by default: Alpha counts.
  expect(await screen.findByText('1 of 3')).toBeInTheDocument()
  expect(box.querySelectorAll('.ProseMirror-search-match')).toHaveLength(2)
  expect(box.querySelectorAll('.ProseMirror-active-search-match')).toHaveLength(1)
})

/** The document as the shell shows it: in a view of its own, beside a
 *  second view when `split` says so, with focus out in the sidebar. */
async function openFromSidebar(split?: { focused: boolean }) {
  files.set(PATH, 'alpha beta alpha\n')
  render(
    <Provider store={store}>
      <button type="button">Plan</button>
      <section data-pane="doc" data-pane-focused={split?.focused || undefined}>
        <DocumentView path={PATH} onOpen={() => undefined} />
      </section>
      {split ? <section data-pane="other" data-pane-focused={!split.focused || undefined} /> : null}
    </Provider>,
  )
  await screen.findByRole('textbox', { name: 'Plan document' })
  const row = screen.getByRole('button', { name: 'Plan' })
  row.focus()
  return row
}

test('Ctrl+F finds in the document in front while focus is in the sidebar', async () => {
  const row = await openFromSidebar()
  expect(press(row, 'f', { ctrlKey: true })).toBe(false)
  const field = await screen.findByRole('textbox', { name: 'Find' })
  await waitFor(() => expect(field).toHaveFocus())
})

test('in a split, Ctrl+F from the sidebar finds only in the focused view', async () => {
  const row = await openFromSidebar({ focused: false })
  expect(press(row, 'f', { ctrlKey: true })).toBe(true)
  expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull()
})

test('a selection over two blocks does not seed, and No results says so', async () => {
  const user = userEvent.setup()
  const { box, editor } = await open('one\n\ntwo\n')
  act(() => {
    editor.commands.setTextSelection({ from: 1, to: 8 })
  })
  press(box, 'f', { ctrlKey: true })
  const field = await screen.findByRole('textbox', { name: 'Find' })
  expect(field).toHaveValue('')
  await user.type(field, 'three')
  expect(await screen.findByText('No results')).toBeInTheDocument()
})

test('Enter and Shift+Enter step through matches; Escape gives the match back', async () => {
  const user = userEvent.setup()
  const { box, editor } = await open('cat dog cat dog cat\n')
  press(box, 'f', { ctrlKey: true })
  const field = await screen.findByRole('textbox', { name: 'Find' })
  await user.type(field, 'cat')
  expect(await screen.findByText('1 of 3')).toBeInTheDocument()

  await user.keyboard('{Enter}')
  expect(await screen.findByText('2 of 3')).toBeInTheDocument()
  await user.keyboard('{Enter}')
  expect(await screen.findByText('3 of 3')).toBeInTheDocument()
  // Wraps.
  await user.keyboard('{Enter}')
  expect(await screen.findByText('1 of 3')).toBeInTheDocument()
  await user.keyboard('{Shift>}{Enter}{/Shift}')
  expect(await screen.findByText('3 of 3')).toBeInTheDocument()
  // Ctrl+G steps too.
  await user.keyboard('{Control>}g{/Control}')
  expect(await screen.findByText('1 of 3')).toBeInTheDocument()

  // Ctrl+F in the bar selects its text rather than reseeding it.
  await user.keyboard('{Control>}f{/Control}')
  expect(field).toHaveFocus()
  expect(field).toHaveValue('cat')
  expect((field as HTMLInputElement).selectionStart).toBe(0)
  expect((field as HTMLInputElement).selectionEnd).toBe(3)

  await user.keyboard('{Escape}')
  expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull()
  expect(editor.state.selection.from).toBe(1)
  expect(selected(editor)).toBe('cat')
  expect(box.querySelectorAll('.ProseMirror-search-match')).toHaveLength(0)
  await waitFor(() => expect(editor.view.hasFocus()).toBe(true))
})

test('match case, whole word and regex change the matches', async () => {
  const user = userEvent.setup()
  const { box } = await open('Note notes note notebook\n')
  press(box, 'f', { ctrlKey: true })
  const field = await screen.findByRole('textbox', { name: 'Find' })
  await user.type(field, 'note')
  expect(await screen.findByText('1 of 4')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Match case' }))
  expect(await screen.findByText(/of 3$/)).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Match whole word' }))
  expect(await screen.findByText('1 of 1')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Match whole word' }))
  await user.click(screen.getByRole('button', { name: 'Match case' }))
  await user.click(screen.getByRole('button', { name: 'Use regular expression' }))
  await user.clear(field)
  await user.type(field, 'notes?\\b')
  expect(await screen.findByText(/of 3$/)).toBeInTheDocument()
})

test('replace all rewrites every match', async () => {
  const user = userEvent.setup()
  const { box, editor } = await open('red, red and red\n')
  press(box, 'f', { ctrlKey: true })
  await user.type(await screen.findByRole('textbox', { name: 'Find' }), 'red')
  await user.click(screen.getByRole('button', { name: 'Show replace' }))
  await user.type(screen.getByRole('textbox', { name: 'Replace' }), 'blue')
  await user.click(screen.getByRole('button', { name: 'Replace all' }))
  expect(editor.getMarkdown().trim()).toBe('blue, blue and blue')
  expect(await screen.findByText('No results')).toBeInTheDocument()
})

test('Ctrl+D with a caret selects the word under it', async () => {
  const { box, editor } = await open('hello world\n')
  act(() => {
    editor.commands.setTextSelection(9)
  })
  expect(press(box, 'd', { ctrlKey: true })).toBe(false)
  expect(selected(editor)).toBe('world')
  // Nothing was duplicated.
  expect(editor.getMarkdown().trim()).toBe('hello world')
})

test('Ctrl+D adds the next occurrence, and typing edits every selection', async () => {
  const { box, editor } = await open('foo bar foo\n\nbaz foo foobar\n')
  act(() => {
    editor.commands.setTextSelection(2)
  })
  press(box, 'd', { ctrlKey: true })
  press(box, 'd', { ctrlKey: true })
  press(box, 'd', { ctrlKey: true })
  // The word came from a caret, so `foobar` is not an occurrence.
  press(box, 'd', { ctrlKey: true })
  expect(extraSelections(editor.state)).toHaveLength(2)
  expect(selected(editor)).toBe('foo')
  expect(box.querySelectorAll('.rich-text-extra-selection')).toHaveLength(2)

  press(box, 'q')
  press(box, 'x')
  expect(editor.getMarkdown().trim()).toBe('qx bar qx\n\nbaz qx foobar')
  expect(box.querySelectorAll('.rich-text-extra-caret')).toHaveLength(2)

  press(box, 'Backspace')
  expect(editor.getMarkdown().trim()).toBe('q bar q\n\nbaz q foobar')

  // Escape collapses to the main selection; typing then edits only it.
  press(box, 'Escape')
  expect(extraSelections(editor.state)).toHaveLength(0)
  act(() => {
    editor.commands.insertContent('!')
  })
  expect(editor.getMarkdown().trim()).toBe('q bar q\n\nbaz q! foobar')
})

test('Ctrl+D from a selection matches inside words too', async () => {
  const { box, editor } = await open('in pin tin\n')
  act(() => {
    editor.commands.setTextSelection({ from: 1, to: 3 })
  })
  press(box, 'd', { ctrlKey: true })
  press(box, 'd', { ctrlKey: true })
  expect(extraSelections(editor.state)).toHaveLength(2)
})

test('Shift+Alt+Down duplicates the block', async () => {
  const { box, editor } = await open('first\n\nsecond\n')
  act(() => {
    editor.commands.setTextSelection(2)
  })
  expect(press(box, 'ArrowDown', { shiftKey: true, altKey: true })).toBe(false)
  expect(editor.getMarkdown().trim()).toBe('first\n\nfirst\n\nsecond')
})
