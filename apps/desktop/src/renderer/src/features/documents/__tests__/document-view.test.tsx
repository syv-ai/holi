/**
 * A document in the rich-text editor against a mocked vault: it opens with
 * its frontmatter kept aside, ⌘B is always the editor's, and Space on an
 * empty line asks Sonnet to write there: the marker is saved, the run locks
 * the page until its session is done, and Stop ends it.
 */
import { emptyVaultSnapshot, normalizeText } from '@holi/shared'
import userEvent from '@testing-library/user-event'
import { atom, createStore, Provider } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { act, fireEvent, render, screen, waitFor } from '@/test/render'
import * as agentService from '@/state/agent-service'
import { pendingHeadingAtom } from '@/state/open-document'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'

import { DocumentView } from '../document-view'

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
const write = vi.fn()
const cap = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    notes: {
      read: {
        query: ({ path }: { path: string }) => Promise.resolve(files.get(path) ?? ''),
      },
      write: {
        mutate: (input: { path: string; text: string }) => {
          files.set(input.path, input.text)
          write(input)
          return Promise.resolve({ ok: true })
        },
      },
    },
    history: {
      list: {
        query: () =>
          Promise.resolve([
            {
              sha: '4a14110aaaa',
              subject: 'Update',
              date: new Date(Date.now() - 2 * 3_600_000).toISOString(),
              author: 'Ada',
              added: 1,
              removed: 0,
            },
          ]),
      },
    },
    github: {
      fileContributors: {
        query: () => Promise.resolve([{ login: 'ada', name: 'Ada', avatarUrl: null }]),
      },
    },
    cap: { run: { mutate: (input: unknown) => cap(input) } },
  },
}))

vi.mock('@/state/agent-service', async () => {
  const { atom: makeAtom } = await import('jotai')
  const sessions = makeAtom<
    { id: string; name: string; state: 'needs-you' | 'working' | 'idle' }[]
  >([])
  return {
    __sessions: sessions,
    useAgentService: () => ({ name: 'Claude', sessions }),
    showAgentSessionAtom: makeAtom(null, () => undefined),
  }
})

const sessions = (
  agentService as unknown as {
    __sessions: ReturnType<
      typeof atom<{ id: string; name: string; state: 'needs-you' | 'working' | 'idle' }[]>
    >
  }
).__sessions

const PATH = 'notes/Plan.md'
let store: ReturnType<typeof createStore>

beforeEach(() => {
  files.clear()
  write.mockReset()
  cap.mockReset()
  cap.mockImplementation(({ name }: { name: string }) =>
    Promise.resolve(name === 'agent.launch' ? { ok: true, sessionId: 'abc12345' } : { ok: true }),
  )
  store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    docs: [{ path: PATH, kind: 'note', updatedAt: '2026-10-23T10:00:00Z' }],
  } as never)
  store.set(sessions, [])
})

afterEach(() => vi.useRealTimers())

function open(text: string) {
  files.set(PATH, text)
  return render(
    <Provider store={store}>
      <DocumentView path={PATH} onOpen={() => undefined} />
    </Provider>,
  )
}

async function editorBox() {
  return await screen.findByRole('textbox', { name: 'Plan document' })
}

test('opens the body in the editor, with its name and contributors', async () => {
  open('---\ntitle: Plan\n---\n\n# Kickoff\n\nSee [[Other]].\n')
  const box = await editorBox()
  expect(screen.getByRole('heading', { level: 1, name: 'Plan' })).toBeVisible()
  expect(box).toHaveTextContent('Kickoff')
  expect(box).toHaveTextContent('See Other.')
  expect(box).not.toHaveTextContent('title: Plan')
  expect(await screen.findByRole('group', { name: 'Written by ada' })).toBeInTheDocument()
})

test('⌘B is always claimed by the editor, never the sidebar toggle', async () => {
  open('Hello\n')
  const box = await editorBox()
  box.focus()
  // Tiptap's Mod is ⌘ on a Mac and Ctrl elsewhere; jsdom is not a Mac.
  const allowed = fireEvent.keyDown(box, { key: 'b', code: 'KeyB', ctrlKey: true })
  expect(allowed).toBe(false)
})

test('Space on an empty line asks Sonnet, locks the page, and unlocks when done', async () => {
  const user = userEvent.setup()
  open('---\ntitle: Plan\n---\n\n')
  const box = await editorBox()
  box.focus()
  fireEvent.keyDown(box, { key: ' ', code: 'Space' })

  const prompt = await screen.findByRole('textbox', {
    name: 'What should the agent do?',
  })
  await user.type(prompt, 'Write an introduction{Enter}')

  await waitFor(() =>
    expect(cap).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent.launch', remote: 'syv/vault' }),
    ),
  )
  const launch = JSON.parse(cap.mock.calls[0]![0].paramsJson)
  expect(launch.model).toBe('claude-sonnet-5-5')
  expect(launch.prompt).toContain('Write an introduction')
  expect(launch.allow).toContain('Edit(./notes/Plan.md)')
  // The marker was saved where the person asked, under the kept frontmatter.
  expect(files.get(PATH)).toBe('---\ntitle: Plan\n---\n\n<!-- holi:agent -->\n')

  await waitFor(() => expect(box).toHaveAttribute('contenteditable', 'false'))
  expect(screen.getByText('Locked')).toBeInTheDocument()

  act(() => store.set(sessions, [{ id: 'abc12345', name: '', state: 'working' }]))
  expect(await screen.findByText('Writing…')).toBeInTheDocument()

  act(() => store.set(sessions, [{ id: 'abc12345', name: '', state: 'idle' }]))
  await waitFor(() => expect(box).toHaveAttribute('contenteditable', 'true'))
})

test('Stop ends the run', async () => {
  const user = userEvent.setup()
  open('')
  const box = await editorBox()
  box.focus()
  fireEvent.keyDown(box, { key: ' ', code: 'Space' })
  await user.type(
    await screen.findByRole('textbox', { name: 'What should the agent do?' }),
    'Draft it{Enter}',
  )
  await user.click(await screen.findByRole('button', { name: 'Stop' }))
  await waitFor(() =>
    expect(cap).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'agent.stop',
        paramsJson: JSON.stringify({ id: 'abc12345' }),
      }),
    ),
  )
  expect(await screen.findByText('Stopped')).toBeInTheDocument()
})

test("the menu copies the document's Holi link", async () => {
  const user = userEvent.setup()
  const writeText = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
  open('# Plan\n\nBody\n')
  await editorBox()
  await user.click(screen.getByRole('button', { name: 'Document actions' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Copy Holi Link' }))
  expect(writeText).toHaveBeenCalledWith('holi://open?vault=syv/vault&path=notes/Plan.md')
  expect(screen.getByRole('menuitem', { name: 'Copied' })).toBeInTheDocument()
})

test("a Holi link's heading puts the caret on it when the document opens", async () => {
  store.set(pendingHeadingAtom, { path: PATH, heading: 'next-steps' })
  open('# Plan\n\nIntro\n\n## Next steps\n\nShip it.\n')
  const box = await editorBox()
  await waitFor(() => expect(store.get(pendingHeadingAtom)).toBeNull())
  const heading = box.querySelector('h2')!
  const selection = window.getSelection()!
  expect(heading.contains(selection.anchorNode)).toBe(true)
})

test('a document switched away from and back to keeps its caret', async () => {
  const text = '# Plan\n\nIntro\n\n## Next steps\n\nShip it.\n'
  const first = open(text)
  const box = await editorBox()
  const editor = (box as WithEditor).editor
  let at = -1
  editor.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isText && node.text!.includes('Ship')) at = pos + 2
  })
  act(() => {
    editor.commands.setTextSelection(at)
  })

  // The tab goes, and comes back on the same store.
  first.unmount()
  open(text)
  const back = ((await editorBox()) as WithEditor).editor
  await waitFor(() => expect(back.state.selection.from).toBe(at))
})

type WithEditor = HTMLElement & { editor: import('@tiptap/react').Editor }

/** The position `offset` characters into the first text that holds `needle`. */
function textPos(editor: import('@tiptap/react').Editor, needle: string, offset = 0): number {
  let at = -1
  editor.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isText && node.text!.includes(needle))
      at = pos + node.text!.indexOf(needle) + offset
  })
  return at
}

/** The file changes on disk, and the snapshot reports its new time. */
function changeOnDisk(text: string, updatedAt: string) {
  files.set(PATH, text)
  act(() =>
    store.set(snapshotAtom, {
      ...emptyVaultSnapshot(),
      docs: [{ path: PATH, kind: 'note', updatedAt }],
    } as never),
  )
}

test('the commit tidy leaves the caret, and the space before it, where they are', async () => {
  open('# Plan\n\nAlpha\n\nBeta\n')
  const editor = ((await editorBox()) as WithEditor).editor
  act(() => {
    // A word, a space, and a pause to think.
    editor
      .chain()
      .setTextSelection(textPos(editor, 'Alpha', 5))
      .insertContent(' hello ')
      .run()
  })
  const caret = editor.state.selection.from
  // Autosave writes the trailing space; the commit's normalize-md strips it.
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1), { timeout: 2000 })
  const saved = files.get(PATH)!
  const tidied = normalizeText(saved, PATH, [])
  expect(tidied).not.toBe(saved)
  changeOnDisk(tidied, '2026-10-23T10:00:05Z')

  // Give the reload its read, and a save its delay.
  await act(() => new Promise((resolve) => setTimeout(resolve, 800)))
  expect(editor.state.selection.from).toBe(caret)
  expect(editor.state.selection.$from.parent.textContent).toBe('Alpha hello ')
  // The untidied buffer is nothing new, so it is not written back.
  expect(write).toHaveBeenCalledTimes(1)
})

test('a change on disk keeps the caret in its place, and is not undoable', async () => {
  open('# Plan\n\nAlpha\n\nBeta\n')
  const editor = ((await editorBox()) as WithEditor).editor
  act(() => {
    editor.commands.setTextSelection(textPos(editor, 'Alpha', 2))
  })

  // A pull or the agent: words added below the caret.
  changeOnDisk('# Plan\n\nAlpha\n\nBeta gamma\n', '2026-10-23T10:00:05Z')
  await waitFor(() => expect(editor.state.doc.textContent).toContain('Beta gamma'))

  const { $from } = editor.state.selection
  expect($from.parent.textContent).toBe('Alpha')
  expect($from.parentOffset).toBe(2)

  // ⌘Z undoes your own edits, never a co-author's.
  act(() => {
    editor.commands.undo()
  })
  expect(editor.state.doc.textContent).toContain('Beta gamma')
  expect(write).not.toHaveBeenCalled()
})

/** Select `words` in the editor and wait for the format bubble's Ask AI. */
async function selectForAskAi(words: string) {
  const box = await editorBox()
  const editor = (box as HTMLElement & { editor: import('@tiptap/react').Editor }).editor
  let from = -1
  editor.state.doc.descendants((node, pos) => {
    if (from === -1 && node.isText && node.text!.includes(words)) {
      from = pos + node.text!.indexOf(words)
    }
  })
  act(() => {
    editor
      .chain()
      .focus()
      .setTextSelection({ from, to: from + words.length })
      .run()
  })
  const selected = () =>
    editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)
  return { editor, selected, askAi: await screen.findByRole('button', { name: 'Ask AI' }) }
}

test("Ask AI's own instruction rewrites only the passage selected when it opened", async () => {
  const user = userEvent.setup()
  open('# Plan\n\nShip the beta on Friday.\n\nKeep this line.\n')
  const { editor, selected, askAi } = await selectForAskAi('Ship the beta')
  await user.click(askAi)
  // The presets are still there, beside the custom entry.
  expect(await screen.findByRole('menuitem', { name: 'Improve writing' })).toBeInTheDocument()
  await user.click(screen.getByRole('menuitem', { name: 'Custom instruction…' }))

  const prompt = await screen.findByRole('textbox', { name: 'What should the agent do?' })
  await waitFor(() => expect(prompt).toHaveFocus())
  // The selection is kept while the prompt has focus.
  expect(selected()).toBe('Ship the beta')
  // The selection moves while the prompt is open; the instruction is still
  // for the passage it opened over.
  let keep = -1
  editor.state.doc.descendants((node, pos) => {
    if (keep === -1 && node.isText && node.text!.startsWith('Keep this line')) keep = pos
  })
  act(() => {
    editor.commands.setTextSelection({ from: keep, to: keep + 'Keep this line'.length })
  })
  expect(selected()).toBe('Keep this line')
  await user.type(prompt, 'Translate it into Danish{Enter}')

  await waitFor(() =>
    expect(cap).toHaveBeenCalledWith(expect.objectContaining({ name: 'agent.launch' })),
  )
  const launch = JSON.parse(cap.mock.calls[0]![0].paramsJson)
  expect(launch.prompt).toContain('<passage>\nShip the beta\n</passage>')
  expect(launch.prompt).not.toContain('Keep this line')
  expect(launch.prompt).toContain('Translate it into Danish')
  expect(launch.prompt).toContain('change nothing else in the document')
  expect(launch.allow).toEqual([
    'Read(./notes/Plan.md)',
    'Edit(./notes/Plan.md)',
    'Write(./notes/Plan.md)',
  ])
  // The page is locked while it runs.
  await waitFor(() => expect(editor.isEditable).toBe(false))
})

test("cancelling Ask AI's own instruction starts nothing and keeps the selection", async () => {
  const user = userEvent.setup()
  open('# Plan\n\nShip the beta on Friday.\n')
  const { editor, selected, askAi } = await selectForAskAi('Ship the beta')
  const before = editor.getMarkdown()
  await user.click(askAi)
  await user.click(await screen.findByRole('menuitem', { name: 'Custom instruction…' }))
  const prompt = await screen.findByRole('textbox', { name: 'What should the agent do?' })
  await waitFor(() => expect(prompt).toHaveFocus())
  // An empty instruction is not sent.
  await user.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  await user.type(prompt, 'Make it formal{Escape}')

  await waitFor(() =>
    expect(screen.queryByRole('textbox', { name: 'What should the agent do?' })).toBeNull(),
  )
  expect(cap).not.toHaveBeenCalled()
  expect(editor.getMarkdown()).toBe(before)
  expect(selected()).toBe('Ship the beta')
})
