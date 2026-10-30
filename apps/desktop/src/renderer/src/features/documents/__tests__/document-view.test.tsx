/**
 * A document in the rich-text editor against a mocked vault: it opens with
 * its frontmatter kept aside, ⌘B is always the editor's, and Space on an
 * empty line asks Sonnet to write there: the marker is saved, the run locks
 * the page until its session is done, and Stop ends it. Ask AI's Start chat
 * opens a conversation about the selected passage beside the document. Create
 * vault app runs on this machine's agent as a session the person can open, and
 * opens the app once its `app.yaml` lands.
 */
import { emptyVaultSnapshot, normalizeText, VAULT_SETTING_DEFAULTS } from '@holi/shared'
import userEvent from '@testing-library/user-event'
import { atom, createStore, Provider } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { act, fireEvent, render, screen, waitFor, within } from '@/test/render'
import * as agentService from '@/state/agent-service'
import { installedPluginsAtom } from '@/state/plugins'
import type { ConversationStart } from '@/state/plugin-types'
import { pendingHeadingAtom } from '@/state/open-document'
import { vaultSettingsAtom } from '@/state/settings'
import { openTabAtom } from '@/state/shell-tabs'
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
    // The agents' names answer on their own, out of `cap`'s calls.
    cap: {
      run: {
        mutate: (input: { name: string }) =>
          input.name === 'agent.providers'
            ? Promise.resolve([
                { id: 'claude', label: 'Claude Code' },
                { id: 'codex', label: 'Codex' },
              ])
            : cap(input),
      },
    },
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
    showAgentSessionAtom: makeAtom(null, (_get, _set, args: unknown) => shown(args)),
  }
})

const shown = vi.hoisted(() => vi.fn())

/** The plugin that provides the agent, as far as core's state can tell. */
const AGENT_PLUGIN = {
  info: { id: 'stand-in', label: 'Stand-in', default: true },
  agent: { name: 'Claude' },
} as never

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
  store.set(installedPluginsAtom, [AGENT_PLUGIN])
  shown.mockReset()
  store.set(vaultSettingsAtom, {
    remote: 'syv/vault',
    settings: { ...VAULT_SETTING_DEFAULTS, warnings: [] },
  })
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
  await user.click(await screen.findByRole('menuitem', { name: 'Copy Holi link' }))
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

/** Open the document as the tab in front, with a spy for what it opens. */
function openFocused(text: string) {
  files.set(PATH, text)
  store.set(openTabAtom, { kind: 'doc', path: PATH })
  const onOpen = vi.fn()
  render(
    <Provider store={store}>
      <DocumentView path={PATH} onOpen={onOpen} />
    </Provider>,
  )
  return onOpen
}

async function createVaultApp() {
  const user = userEvent.setup()
  await editorBox()
  await user.click(screen.getByRole('button', { name: 'Document actions' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Create vault app' }))
  await waitFor(() =>
    expect(cap).toHaveBeenCalledWith(expect.objectContaining({ name: 'agent.scoped' })),
  )
  return JSON.parse(cap.mock.calls.find(([c]) => c.name === 'agent.scoped')![0].paramsJson)
}

const NOW = '2026-10-30T10:00:00Z'

/** The app's finished marker lands in the vault. */
function appWritten(app: string) {
  act(() =>
    store.set(snapshotAtom, (s) => ({
      ...s,
      files: [
        ...s.files,
        { path: `${app}/index.html`, updatedAt: NOW },
        { path: `${app}/app.yaml`, updatedAt: NOW },
      ],
    })),
  )
}

test('Create vault app runs on Claude Code as a session, and opens the app beside the note', async () => {
  cap.mockImplementation(({ name }: { name: string }) =>
    Promise.resolve(name === 'agent.scoped' ? { ok: true, sessionId: 'abc12345' } : { ok: true }),
  )
  const onOpen = openFocused('# Plan\n')
  const job = await createVaultApp()
  expect(job).toMatchObject({
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    scope: { read: [PATH], write: ['notes/Plan.app/**'] },
  })
  expect(job.prompt).toContain('`notes/Plan.app`')
  // A session the person watches: not told nobody is.
  expect(job.system).not.toMatch(/nobody is watching/i)
  expect(screen.queryByText(/artifact/i)).toBeNull()
  // The page is not locked: the app is beside it, not in it.
  expect(await editorBox()).toHaveAttribute('contenteditable', 'true')

  act(() => store.set(sessions, [{ id: 'abc12345', name: '', state: 'working' }]))
  expect(await screen.findByText('Creating the vault app…')).toBeInTheDocument()
  // Its session can be opened, watched and added to while it works.
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open session' }))
  expect(shown).toHaveBeenCalledWith({ session: 'abc12345', live: true })
  // Idle with no app yet: it waits on the person, and is not done.
  act(() => store.set(sessions, [{ id: 'abc12345', name: '', state: 'idle' }]))
  expect(await screen.findByText('Waiting for you in Agents')).toBeInTheDocument()
  expect(onOpen).not.toHaveBeenCalled()
  appWritten('notes/Plan.app')
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('notes/Plan.app'))
})

test('Create vault app runs on Codex when it is the default, under a free name', async () => {
  cap.mockImplementation(({ name }: { name: string }) =>
    Promise.resolve(
      name === 'agent.scoped' ? { ok: true, sessionId: 'p0123456789ab' } : { ok: true },
    ),
  )
  store.set(vaultSettingsAtom, {
    remote: 'syv/vault',
    settings: { ...VAULT_SETTING_DEFAULTS, agentProvider: 'codex', warnings: [] },
  })
  // An app of that name is already there, and an old artifact is left alone.
  store.set(snapshotAtom, (s) => ({
    ...s,
    dirs: ['notes', 'notes/Plan.app', 'notes/Plan Artifact.app'],
  }))
  const onOpen = openFocused('# Plan\n')
  const job = await createVaultApp()
  expect(job.provider).toBe('codex')
  expect(job.model).toBeUndefined()
  expect(job.scope.write).toEqual(['notes/Plan 2.app/**'])

  act(() => store.set(sessions, [{ id: 'p0123456789ab', name: '', state: 'working' }]))
  // A turn's end copied the app back while its session goes on.
  appWritten('notes/Plan 2.app')
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('notes/Plan 2.app'))
})

test("a vault app's failure shows in the run's pill, and nothing opens", async () => {
  cap.mockImplementation(({ name }: { name: string }) =>
    Promise.resolve(
      name === 'agent.scoped'
        ? { ok: false, message: 'Codex cannot run a session fenced to what it may touch.' }
        : { ok: true },
    ),
  )
  store.set(vaultSettingsAtom, {
    remote: 'syv/vault',
    settings: { ...VAULT_SETTING_DEFAULTS, agentProvider: 'codex', warnings: [] },
  })
  const onOpen = openFocused('# Plan\n')
  await createVaultApp()
  expect(
    await screen.findByText('Codex cannot run a session fenced to what it may touch.'),
  ).toBeInTheDocument()
  expect(onOpen).not.toHaveBeenCalled()
})

test('a vault app Claude Code would not start says why in the pill', async () => {
  cap.mockImplementation(({ name }: { name: string }) =>
    Promise.resolve(
      name === 'agent.scoped'
        ? { ok: false, message: 'This folder is not trusted by Claude Code.' }
        : { ok: true },
    ),
  )
  const onOpen = openFocused('# Plan\n')
  await createVaultApp()
  expect(await screen.findByText('This folder is not trusted by Claude Code.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Trust in Claude Code' })).toBeInTheDocument()
  expect(onOpen).not.toHaveBeenCalled()
})

test('a vault app made while another tab is in front waits on Open', async () => {
  cap.mockImplementation(({ name }: { name: string }) =>
    Promise.resolve(name === 'agent.scoped' ? { ok: true, sessionId: 'abc12345' } : { ok: true }),
  )
  const onOpen = openFocused('# Plan\n')
  await createVaultApp()
  act(() => store.set(sessions, [{ id: 'abc12345', name: '', state: 'working' }]))
  act(() => store.set(openTabAtom, { kind: 'doc', path: 'notes/Other.md' }))
  act(() => store.set(sessions, []))
  appWritten('notes/Plan.app')
  const openButton = await screen.findByRole('button', { name: 'Open' })
  expect(screen.getByText('The vault app is ready')).toBeInTheDocument()
  expect(onOpen).not.toHaveBeenCalled()
  await userEvent.setup().click(openButton)
  expect(onOpen).toHaveBeenCalledWith('notes/Plan.app')
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

test("Ask AI's rewrite commands read as one group, and Start chat comes after them", async () => {
  const user = userEvent.setup()
  store.set(installedPluginsAtom, [
    {
      info: { id: 'agent-stand-in', label: 'Agent', default: true },
      agentsSlot: { start: atom(null, () => Promise.resolve({ ok: true as const })) },
    },
  ] as never)
  open('# Plan\n\nShip the beta on Friday.\n')
  const { askAi } = await selectForAskAi('Ship the beta')
  await user.click(askAi)
  const menu = await screen.findByRole('menu')
  // The custom instruction is a rewrite too: inside the group, under its label.
  const rewrite = within(menu).getByRole('group')
  expect(within(rewrite).getByText('Rewrite the selection')).toBeInTheDocument()
  expect(within(rewrite).getByRole('menuitem', { name: 'Custom instruction…' })).toBeInTheDocument()
  const rows = [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((el) =>
    el.getAttribute('role') === 'separator' ? '---' : el.textContent,
  )
  expect(rows).toEqual([
    'Improve writing',
    'Fix spelling and grammar',
    'Simplify',
    'Make shorter',
    'Custom instruction…',
    '---',
    'Start chat',
  ])
})

test('Start chat opens a new session beside the document, the passage as its context', async () => {
  const user = userEvent.setup()
  const started: ConversationStart[] = []
  store.set(installedPluginsAtom, [
    {
      info: { id: 'agent-stand-in', label: 'Agent', default: true },
      agentsSlot: {
        start: atom(null, (_get, _set, args: ConversationStart) => {
          started.push(args)
          return Promise.resolve({ ok: true as const })
        }),
      },
    },
  ] as never)
  open('# Plan\n\nShip the beta on Friday.\n\nKeep this line.\n')
  const { editor, askAi } = await selectForAskAi('Ship the beta')
  const before = editor.getMarkdown()
  await user.click(askAi)
  await user.click(await screen.findByRole('menuitem', { name: 'Start chat' }))

  await waitFor(() => expect(started).toHaveLength(1))
  expect(started[0]).toEqual({
    text: '',
    context: [{ kind: 'passage', path: PATH, text: 'Ship the beta' }],
    beside: true,
  })
  // A chat changes nothing: no rewrite run, and the page stays editable.
  expect(cap).not.toHaveBeenCalled()
  expect(editor.isEditable).toBe(true)
  expect(editor.getMarkdown()).toBe(before)
})

test("Create vault app waits until this machine's agent is read", async () => {
  const user = userEvent.setup()
  store.set(vaultSettingsAtom, null)
  openFocused('# Plan\n')
  await editorBox()
  await user.click(screen.getByRole('button', { name: 'Document actions' }))
  expect(await screen.findByRole('menuitem', { name: 'Create vault app' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  expect(cap).not.toHaveBeenCalled()
})

test('Stop while a vault app is starting stops the session the start returns', async () => {
  let started!: (r: { ok: true; sessionId: string }) => void
  cap.mockImplementation(({ name }: { name: string }) =>
    name === 'agent.scoped'
      ? new Promise((r) => (started = r))
      : Promise.resolve(name === 'agent.providers' ? [] : { ok: true }),
  )
  openFocused('# Plan\n')
  await createVaultApp()
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Stop' }))
  expect(await screen.findByText('Stopped')).toBeInTheDocument()
  expect(cap).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'agent.stop' }))
  await act(async () => started({ ok: true, sessionId: 'p0123456789ab' }))
  await waitFor(() =>
    expect(cap).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'agent.stop',
        paramsJson: JSON.stringify({ id: 'p0123456789ab' }),
      }),
    ),
  )
  expect(screen.getByText('Stopped')).toBeInTheDocument()
})

test('Stop on a vault app wins over its app landing after it', async () => {
  cap.mockImplementation(({ name }: { name: string }) =>
    Promise.resolve(
      name === 'agent.scoped' ? { ok: true, sessionId: 'p0123456789ab' } : { ok: true },
    ),
  )
  const onOpen = openFocused('# Plan\n')
  await createVaultApp()
  act(() => store.set(sessions, [{ id: 'p0123456789ab', name: '', state: 'working' }]))
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Stop' }))
  await waitFor(() =>
    expect(cap).toHaveBeenCalledWith(expect.objectContaining({ name: 'agent.stop' })),
  )
  // The copy back as its session closed lands after Stop: the run stays stopped.
  act(() => store.set(sessions, []))
  appWritten('notes/Plan.app')
  expect(await screen.findByText('Stopped')).toBeInTheDocument()
  expect(onOpen).not.toHaveBeenCalled()
})
