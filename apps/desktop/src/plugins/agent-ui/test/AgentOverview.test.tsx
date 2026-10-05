/**
 * The agents page: one session's chat, read from the transcript and written
 * through `agent.say`, and the stack of bubbles for every session the vault
 * has had, live or finished (an overlay, rendered beside it here). No terminal is drawn, and every way to a session
 * lands in its chat.
 */
import { render, screen, waitFor, within } from '@/test/render'
import { fireEvent } from '@testing-library/react'
import { act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom, openSurfaceAtom, surfaceTabIdsAtom } from '@/plugin-api'
import { AgentBubbles } from '../renderer/AgentBubbles'
import { AgentOverview } from '../renderer/AgentOverview'
import { headOf } from '../renderer/AgentFace'
import { toChatItems } from '../../agent/renderer/chat/use-transcript'
import { openSessionAtom, sendToAgentAtom, showAgentsAtom } from '../../agent/renderer/state/send'
import {
  activeSessionAtom,
  agentSessionsAtom,
  agentArchivedAtom,
  agentHistoryAtom,
  agentStackAtom,
  agentViewAtom,
  chatDraftsAtom,
  overviewSelectionAtom,
  type AgentSession,
  type PastSession,
} from '../../agent/renderer/state/sessions'

const cap = vi.hoisted(() => ({
  open: vi.fn(),
  say: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  upload: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  transcript: vi.fn(),
  question: vi.fn(),
}))
vi.mock('../../agent/renderer/agent-cap', () => ({
  agentCap: {
    open: (_remote: string, args: unknown) => cap.open(args),
    start: (_remote: string, args: unknown) => cap.start(args),
    stop: (_remote: string, args: unknown) => cap.stop(args),
    upload: (_remote: string, args: unknown) => cap.upload(args),
    archive: (_remote: string, args: unknown) => cap.archive(args),
    remove: (_remote: string, args: unknown) => cap.remove(args),
    say: (_remote: string, args: unknown) => cap.say(args),
    transcript: (_remote: string, args: unknown) => cap.transcript(args),
    question: (_remote: string, args: unknown) => cap.question(args),
  },
}))
// xterm needs a canvas; no test here is about what a terminal draws.
vi.mock('../renderer/SessionTerminal', () => ({
  SessionTerminal: ({ terminalId }: { terminalId: string }) => (
    <div data-testid={`terminal-${terminalId}`} />
  ),
}))
vi.mock('../renderer/TurnChip', () => ({ TurnChip: () => null }))
// What is typed into a session's terminal, as the chat's key presses are.
const typed = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../../agent/renderer/lib/session-terminals', async (original) => ({
  ...(await original<typeof import('../../agent/renderer/lib/session-terminals')>()),
  typeIntoTerminal: (_remote: string, id: string, data: string) => typed.fn(id, data),
}))

const TRANSCRIPT = {
  sessionId: 'conversation-a',
  offset: 10,
  entries: [
    { kind: 'user', id: 'u1', text: 'Book the flights' },
    { kind: 'assistant', id: 'a1', text: 'On it, **looking** now.' },
    { kind: 'tool', id: 'call-1', name: 'Bash', summary: 'ls flights', input: '{}' },
    { kind: 'tool-result', id: 'call-1', ok: true, text: 'two found' },
  ],
}

beforeEach(() => {
  for (const fn of Object.values(cap)) fn.mockReset()
  cap.archive.mockResolvedValue({ ok: true })
  cap.remove.mockResolvedValue({ ok: true })
  cap.stop.mockResolvedValue({ ok: true })
  cap.question.mockResolvedValue(null)
  typed.fn.mockReset()
  cap.open.mockResolvedValue({ ok: true, terminalId: 't-new' })
  cap.say.mockResolvedValue({ ok: true, terminalId: 't-a' })
  cap.transcript.mockImplementation(({ offset }: { offset?: number }) =>
    Promise.resolve(offset === undefined ? TRANSCRIPT : { ...TRANSCRIPT, entries: [] }),
  )
})

const SESSIONS: AgentSession[] = [
  { id: 'a', name: 'Travel agent', state: 'idle', phase: 'done', startedAt: 3000 },
  {
    id: 'b',
    name: 'Chief of staff',
    state: 'needs-you',
    waitingFor: 'permission prompt',
    startedAt: 1000,
  },
]
const HISTORY: PastSession[] = [
  { id: 'c', name: 'Old taxes', phase: 'done', startedAt: 2000 },
  { id: 'd', name: 'Broken import', phase: 'failed', startedAt: 500 },
]

let current: ReturnType<typeof createStore>

function setup(
  sessions: AgentSession[] = SESSIONS,
  history: PastSession[] = HISTORY,
  archived: string[] = [],
  /** On the agents page itself, as the page under test is. */
  onPage = true,
) {
  const store = createStore()
  current = store
  store.set(activeRemoteAtom, 'o/vault')
  store.set(agentSessionsAtom, sessions)
  store.set(agentHistoryAtom, history)
  store.set(agentArchivedAtom, archived)
  if (onPage) store.set(openSurfaceAtom, 'agent')
  render(
    <Provider store={store}>
      <AgentOverview visible />
      <AgentBubbles />
    </Provider>,
  )
  return { store, user: userEvent.setup() }
}

const bubble = (id: string) => document.querySelector<HTMLElement>(`[data-agent-bubble="${id}"]`)!
const stack = () => document.querySelector<HTMLElement>('[data-agent-stack]')!

test('the stack is every session, live and finished, the most recent on top', () => {
  const { store } = setup()
  expect(store.get(agentStackAtom).map((e) => e.id)).toEqual(['a', 'c', 'b', 'd'])
  const shown = [...document.querySelectorAll('[data-agent-bubble]')].map((el) =>
    el.getAttribute('data-agent-bubble'),
  )
  expect(shown).toEqual(['a', 'c', 'b', 'd'])
  expect(bubble('c')).toHaveAttribute('data-kind', 'past')
  expect(bubble('a')).toHaveAttribute('data-kind', 'live')
  // The ones the resting stack hides are counted.
  expect(screen.getByText('+1')).toBeInTheDocument()
})

test('a session with no start time is the oldest', () => {
  const { store } = setup([{ id: 'x', name: 'Undated', state: 'idle' }, ...SESSIONS], HISTORY)
  expect(store.get(agentStackAtom).at(-1)?.id).toBe('x')
})

test('the page opens on the most recent session, as a chat with no terminal', async () => {
  const { store } = setup()
  const chat = document.querySelector<HTMLElement>('[data-agent-chat="a"]')!
  expect(await within(chat).findByText('Book the flights')).toBeInTheDocument()
  // Markdown is rendered, and the tool call is one row with its result in it.
  expect(within(chat).getByText('looking').tagName).toBe('STRONG')
  expect(within(chat).getByText('ls flights')).toBeInTheDocument()
  expect(screen.queryByTestId(/^terminal-/)).toBeNull()
  expect(cap.open).not.toHaveBeenCalled()
  expect(bubble('a')).toHaveAttribute('aria-current', 'true')
  // One page, not a tab per session.
  expect(store.get(surfaceTabIdsAtom('agent'))).toEqual([])
  expect(store.get(activeSessionAtom)?.id).toBe('a')
})

test('the stack fans out under the pointer and folds when it leaves', async () => {
  const { user } = setup()
  expect(stack()).not.toHaveAttribute('data-open')
  await user.hover(bubble('a'))
  expect(stack()).toHaveAttribute('data-open')
  await user.unhover(bubble('a'))
  await waitFor(() => expect(stack()).not.toHaveAttribute('data-open'))
})

test('the keyboard reaches the whole stack, and Escape folds it', async () => {
  const { user } = setup()
  act(() => bubble('d').focus())
  expect(stack()).toHaveAttribute('data-open')
  await user.keyboard('{Escape}')
  expect(stack()).not.toHaveAttribute('data-open')
})

test('a bubble opens that session, one chat at a time', async () => {
  const { store, user } = setup()
  await user.click(bubble('b'))
  expect(store.get(overviewSelectionAtom)).toBe('b')
  expect(await screen.findByText('Allow this to run?')).toBeInTheDocument()
  await waitFor(() => expect(document.querySelector('[data-agent-chat="a"]')).toBeNull())
  expect(bubble('b')).toHaveAttribute('aria-current', 'true')
  expect(stack()).not.toHaveAttribute('data-open')
})

test('a finished session reads as a chat that can be picked up, not written to', async () => {
  const { user } = setup()
  await user.click(bubble('c'))
  const chat = document.querySelector<HTMLElement>('[data-agent-chat="c"]')!
  expect(await within(chat).findByText('Book the flights')).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Show the terminal' })).toBeNull()
  expect(cap.open).not.toHaveBeenCalled()

  // Picking it up opens a terminal on it, which Claude Code resumes it for.
  await user.click(screen.getByRole('button', { name: 'Pick up' }))
  expect(cap.open).toHaveBeenCalledWith(expect.objectContaining({ attach: 'c' }))
})

test('a session that ended badly says so', async () => {
  const { user } = setup()
  await user.click(bubble('d'))
  expect(screen.getAllByText(/Ended badly/).length).toBeGreaterThan(0)
})

test('a message is sent as a turn, and shows at once', async () => {
  const { user } = setup()
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'And a hotel{Enter}')
  expect(cap.say).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', text: 'And a hotel' }))
  expect(screen.getByText('And a hotel')).toBeInTheDocument()
  expect(draftOf()).toBe('')
})

test('a send that main refuses puts the text back and says why', async () => {
  cap.say.mockRejectedValue(new Error('no such method: agent.say'))
  const { user } = setup()
  const box = screen.getByRole('textbox', { name: 'Message' })
  await user.type(box, 'And a hotel{Enter}')
  expect(await screen.findByText(/needs a restart/)).toBeInTheDocument()
  expect(draftOf()).toBe('And a hotel')
})

test('a conversation that cannot be read says so rather than looking empty', async () => {
  cap.transcript.mockRejectedValue(new Error('no such method: agent.transcript'))
  setup()
  expect(await screen.findByText(/could not be read/)).toBeInTheDocument()
})

test('a session that waits on you says so in the chat, and takes no message', async () => {
  const { user } = setup()
  await user.click(bubble('b'))
  expect(await screen.findByText('Allow this to run?')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('aria-disabled', 'true')
})

test('a session opened from anywhere lands in its chat', async () => {
  const { store } = setup()
  await store.set(openSessionAtom, 'b')
  expect(store.get(overviewSelectionAtom)).toBe('b')
  expect(cap.open).not.toHaveBeenCalled()
})

test("an ask lands in the chat's composer, unsent", async () => {
  const { store } = setup()
  await store.set(sendToAgentAtom, { text: 'About this note', target: 'a' })
  expect(store.get(chatDraftsAtom)).toEqual({ a: 'About this note' })
  expect(store.get(overviewSelectionAtom)).toBe('a')
  expect(cap.say).not.toHaveBeenCalled()
})

test('an ask for a session that has finished is refused', async () => {
  const { store } = setup()
  const res = await store.set(sendToAgentAtom, { text: 'Hello', target: 'c' })
  expect(res).toEqual({ ok: false, message: expect.stringMatching(/has ended/) })
})

test('the agents command opens the page, not a list terminal', async () => {
  const { store } = setup()
  await store.set(showAgentsAtom)
  expect(store.get(surfaceTabIdsAtom('agent'))).toEqual([])
  expect(cap.open).not.toHaveBeenCalled()
})

test('a new session is one press from the stack', async () => {
  cap.start.mockResolvedValue({ ok: true, terminalId: 't-new', sessionId: 'n' })
  const { store, user } = setup()
  await user.click(screen.getByRole('button', { name: 'New session' }))
  expect(cap.start).toHaveBeenCalled()
  await waitFor(() => expect(store.get(overviewSelectionAtom)).toBe('n'))
})

test('with no session ever it says so and offers one', () => {
  setup([], [])
  expect(screen.getByText('No agent has run here yet.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Start a session' })).toBeInTheDocument()
})

test('a tool call and its result are one item', () => {
  const items = toChatItems(TRANSCRIPT.entries as Parameters<typeof toChatItems>[0])
  expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool'])
  expect(items[2]).toMatchObject({ result: { ok: true, text: 'two found' } })
})

test('a session keeps its colour', () => {
  expect(headOf('a')).toBe(headOf('a'))
})

test('stopping an idle session is one press in its menu; a busy one asks first', async () => {
  cap.stop.mockResolvedValue({ ok: true })
  cap.question.mockResolvedValue(null)
  const { user } = setup(
    [
      { id: 'a', name: 'Travel agent', state: 'idle', phase: 'done', startedAt: 3000 },
      { id: 'w', name: 'Busy one', state: 'working', startedAt: 2000 },
    ],
    [],
  )
  await user.pointer({ keys: '[MouseRight]', target: bubble('a') })
  await user.click(await screen.findByRole('menuitem', { name: 'Stop session' }))
  expect(cap.stop).toHaveBeenCalledWith({ id: 'a' })

  cap.stop.mockClear()
  await user.pointer({ keys: '[MouseRight]', target: bubble('w') })
  await user.click(await screen.findByRole('menuitem', { name: 'Stop session' }))
  expect(cap.stop).not.toHaveBeenCalled()
  expect(await screen.findByText('Stop Busy one?')).toBeInTheDocument()
})

test('a finished session has no menu to stop it with', async () => {
  const { user } = setup()
  await user.pointer({ keys: '[MouseRight]', target: bubble('c') })
  expect(screen.queryByRole('menuitem', { name: 'Stop session' })).toBeNull()
})

const PATH = (name: string) => `/v/.holi/state/chat.local.uploads/x-ab12cd-${name}`
const bitmap = () => new File(['png-bytes'], 'image.png', { type: 'image/png' })
const composer = () => document.querySelector<HTMLElement>('[data-chat-composer]')!
const box = () => screen.getByRole('textbox', { name: 'Message' })
/** What the draft holds: the text, with a marker where each chip stands. */
const draftOf = () => current.get(chatDraftsAtom)['a'] ?? ''
const chips = () => [...document.querySelectorAll<HTMLElement>('[data-chat-chip]')]
const pasteShot = (target: Element = box()) =>
  fireEvent.paste(target, { clipboardData: { files: [bitmap()], items: [], types: ['Files'] } })

test('a pasted screenshot is a marker in the text, where the cursor was', async () => {
  const { user } = setup()
  await user.type(box(), 'Broken here:')
  pasteShot()
  await waitFor(() => expect(draftOf()).toBe('Broken here: [Image 1] '))
  // An icon chip in the field, not the marker's characters.
  expect(chips()).toHaveLength(1)
  expect(chips()[0]).toHaveAttribute('data-chat-chip', 'image')
  expect(box()).toHaveTextContent('Broken here: Image 1')
  expect(box()).not.toHaveTextContent('[Image 1]')
  // No picture above the text, and nothing pressed into the terminal.
  expect(screen.queryByRole('img')).toBeNull()
  expect(document.querySelector('[data-chat-attachments]')).toBeNull()
  expect(cap.upload).not.toHaveBeenCalled()
})

test('several screenshots can be pasted, each with its own comment', async () => {
  cap.upload.mockImplementation(({ name }: { name: string }) =>
    Promise.resolve({ ok: true, path: PATH(name) }),
  )
  const { user } = setup()
  pasteShot()
  await waitFor(() => expect(draftOf()).toBe('[Image 1] '))
  await user.type(box(), 'is the bug, and ')
  pasteShot()
  await waitFor(() => expect(draftOf()).toContain('[Image 2]'))
  expect(chips()).toHaveLength(2)
  await user.type(box(), 'is what I want{Enter}')

  await waitFor(() => expect(cap.say).toHaveBeenCalled())
  expect(cap.upload).toHaveBeenCalledTimes(2)
  // Each file where its comment is.
  expect(cap.say).toHaveBeenCalledWith(
    expect.objectContaining({
      text: `@${PATH('image.png')} is the bug, and @${PATH('image.png')} is what I want`,
    }),
  )
  await waitFor(() => expect(draftOf()).toBe(''))
  expect(chips()).toHaveLength(0)
})

test('the marker is how a screenshot is removed: deleted, it is not sent', async () => {
  const { user } = setup()
  pasteShot()
  await waitFor(() => expect(draftOf()).toBe('[Image 1] '))
  expect(screen.getByText(/1 attached/)).toBeInTheDocument()
  // The chip deleted, as Backspace does: the file goes with it.
  chips()[0]!.remove()
  fireEvent.input(box())
  await waitFor(() => expect(draftOf()).toBe(' '))
  await user.type(box(), 'never mind{Enter}')
  await waitFor(() =>
    expect(cap.say).toHaveBeenCalledWith(expect.objectContaining({ text: 'never mind' })),
  )
  expect(cap.upload).not.toHaveBeenCalled()
})

test('a file picked or dropped is any file, marked by name and sent by path', async () => {
  cap.upload.mockResolvedValue({ ok: true, path: PATH('notes.pdf') })
  const { user } = setup()
  fireEvent.drop(composer(), {
    dataTransfer: {
      files: [new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' })],
      items: [],
    },
  })
  await waitFor(() => expect(draftOf()).toBe('[notes.pdf] '))
  expect(chips()[0]).toHaveAttribute('data-chat-chip', 'file')
  await user.type(box(), 'summarise this{Enter}')
  await waitFor(() => expect(cap.say).toHaveBeenCalled())
  expect(cap.upload).toHaveBeenCalledWith({ name: 'notes.pdf', data: expect.any(String) })
  expect(cap.say).toHaveBeenCalledWith(
    expect.objectContaining({ text: `@${PATH('notes.pdf')} summarise this` }),
  )
})

test('a message of only a marker is sent, as its file', async () => {
  cap.upload.mockResolvedValue({ ok: true, path: PATH('image.png') })
  const { user } = setup()
  pasteShot()
  await waitFor(() => expect(draftOf()).toBe('[Image 1] '))
  await user.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() =>
    expect(cap.say).toHaveBeenCalledWith(
      expect.objectContaining({ text: `@${PATH('image.png')}` }),
    ),
  )
})

test('a paste anywhere on the page takes an image, even with the box unfocused and the file only in items', async () => {
  setup()
  fireEvent.paste(document.body, {
    clipboardData: {
      files: [],
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => bitmap() }],
      types: ['Files'],
    },
  })
  await waitFor(() => expect(draftOf()).toBe('[Image 1] '))
})

test('a picture the browser gives no bytes for is said, not dropped silently', async () => {
  setup()
  fireEvent.paste(document.body, {
    clipboardData: {
      files: [],
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }],
      types: ['Files'],
    },
  })
  expect(await screen.findByText(/could not be read from the clipboard/)).toBeInTheDocument()
})

test('rich text that carries a picture of itself, and a paste into another field, are left alone', () => {
  setup()
  fireEvent.paste(document.body, {
    clipboardData: { files: [bitmap()], items: [], types: ['text/plain', 'text/html', 'Files'] },
  })
  const outside = document.createElement('input')
  document.body.appendChild(outside)
  pasteShot(outside)
  outside.remove()
  expect(draftOf()).toBe('')
  expect(chips()).toHaveLength(0)
})

test('an upload main refuses keeps the message and its marker, and says why', async () => {
  cap.upload.mockResolvedValue({ ok: false, message: 'That file is over 50 MB.' })
  const { user } = setup()
  pasteShot()
  await waitFor(() => expect(draftOf()).toBe('[Image 1] '))
  await user.type(box(), 'hi{Enter}')
  expect(await screen.findByText('That file is over 50 MB.')).toBeInTheDocument()
  expect(cap.say).not.toHaveBeenCalled()
  // The message and its chip are still there to send again.
  expect(draftOf()).toBe('[Image 1] hi')
  expect(chips()).toHaveLength(1)
})

test('in the conversation a file reads as a chip, a picture as itself, in its place among the words', async () => {
  cap.transcript.mockResolvedValue({
    ...TRANSCRIPT,
    entries: [
      {
        kind: 'user',
        id: 'u9',
        text: `Look at @${PATH('shot.png')} and @${PATH('plan.pdf')} then fix it`,
      },
    ],
  })
  setup()
  const chat = document.querySelector<HTMLElement>('[data-agent-chat="a"]')!
  expect(await within(chat).findByRole('img', { name: 'shot.png' })).toBeInTheDocument()
  expect(within(chat).getByText('plan.pdf')).toBeInTheDocument()
  expect(within(chat).getByText('Look at')).toBeInTheDocument()
  expect(within(chat).getByText('then fix it')).toBeInTheDocument()
})

test('a message with pictures pasted into it says so in the conversation', async () => {
  cap.transcript.mockResolvedValue({
    ...TRANSCRIPT,
    entries: [{ kind: 'user', id: 'u9', text: 'Look', images: 2 }],
  })
  setup()
  const chat = document.querySelector<HTMLElement>('[data-agent-chat="a"]')!
  expect(await within(chat).findByText('Look')).toBeInTheDocument()
  expect(within(chat).getByText('Image 1')).toBeInTheDocument()
  expect(within(chat).getByText('Image 2')).toBeInTheDocument()
})

const menuItem = (name: string) => screen.findByRole('menuitem', { name })
const rightClick = (user: ReturnType<typeof userEvent.setup>, id: string) =>
  user.pointer({ keys: '[MouseRight]', target: bubble(id) })

test('archiving a finished chat takes it out of the stack', async () => {
  const { user } = setup()
  await rightClick(user, 'c')
  await user.click(await menuItem('Archive'))
  expect(cap.archive).toHaveBeenCalledWith({ id: 'c', archived: true })
  expect(cap.stop).not.toHaveBeenCalled()
})

test('archiving a running chat stops it first, so nothing runs out of sight', async () => {
  const { user } = setup(
    [{ id: 'a', name: 'Travel agent', state: 'idle', phase: 'done', startedAt: 3000 }],
    [],
  )
  await rightClick(user, 'a')
  await user.click(await menuItem('Archive'))
  await waitFor(() => expect(cap.archive).toHaveBeenCalledWith({ id: 'a', archived: true }))
  expect(cap.stop).toHaveBeenCalledWith({ id: 'a' })
})

test('archiving a busy chat asks first, and does nothing if refused', async () => {
  const { user } = setup([{ id: 'w', name: 'Busy one', state: 'working', startedAt: 3000 }], [])
  await rightClick(user, 'w')
  await user.click(await menuItem('Archive'))
  expect(await screen.findByText('Archive Busy one?')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(cap.stop).not.toHaveBeenCalled()
  expect(cap.archive).not.toHaveBeenCalled()
})

test('an archived chat is out of the stack, and the history link says how many', () => {
  const { store } = setup(SESSIONS, HISTORY, ['c', 'd'])
  expect(store.get(agentStackAtom).map((e) => e.id)).toEqual(['a', 'b'])
  expect(bubble('c')).toBeNull()
  expect(screen.getByRole('button', { name: 'History · 2' })).toBeInTheDocument()
})

test('the history lists the archived chats, which can be read, brought back or deleted', async () => {
  const { store, user } = setup(SESSIONS, HISTORY, ['c', 'd'])
  await user.click(screen.getByRole('button', { name: 'History · 2' }))
  expect(store.get(agentViewAtom)).toBe('history')
  const history = document.querySelector<HTMLElement>('[data-agent-history]')!
  expect(within(history).getByText('Old taxes')).toBeInTheDocument()
  expect(within(history).getByText('Broken import')).toBeInTheDocument()
  expect(within(history).getByText(/Ended badly/)).toBeInTheDocument()

  // Searched.
  await user.type(within(history).getByRole('textbox', { name: 'Search the history' }), 'tax')
  expect(within(history).queryByText('Broken import')).toBeNull()

  // Brought back.
  await user.click(within(history).getByRole('button', { name: 'Bring back Old taxes' }))
  expect(cap.archive).toHaveBeenCalledWith({ id: 'c', archived: false })

  // Deleted for good, after asking.
  await user.click(within(history).getByRole('button', { name: 'Delete Old taxes' }))
  expect(cap.remove).not.toHaveBeenCalled()
  await user.click(await screen.findByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(cap.remove).toHaveBeenCalledWith({ id: 'c' }))
})

test('the history can delete every archived chat at once', async () => {
  const { user } = setup(SESSIONS, HISTORY, ['c', 'd'])
  await user.click(screen.getByRole('button', { name: 'History · 2' }))
  await user.click(screen.getByRole('button', { name: 'Delete all' }))
  expect(await screen.findByText('Delete 2 chats?')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(cap.remove).toHaveBeenCalledTimes(2))
})

test('an archived chat opened from the history is read as a chat, and picking it up brings it back', async () => {
  const { store, user } = setup(SESSIONS, HISTORY, ['c'])
  await user.click(screen.getByRole('button', { name: 'History · 1' }))
  await user.click(document.querySelector<HTMLElement>('[data-history-row="c"] button')!)
  expect(store.get(agentViewAtom)).toBe('chat')
  const chat = document.querySelector<HTMLElement>('[data-agent-chat="c"]')!
  expect(await within(chat).findByText('Book the flights')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Pick up' }))
  expect(cap.archive).toHaveBeenCalledWith({ id: 'c', archived: false })
})

test('with every chat archived the stack is still there, as a way to start another', () => {
  setup([], [HISTORY[0]!], ['c'])
  expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'History · 1' })).toBeInTheDocument()
})

test('each row of the fan has its own archive button, on the left, and its face on the right', async () => {
  const { user } = setup()
  await user.hover(bubble('a'))
  await user.click(screen.getByRole('button', { name: 'Archive Old taxes' }))
  expect(cap.archive).toHaveBeenCalledWith({ id: 'c', archived: true })
  // The row's face is its bubble, last, where the resting stack's bubble is;
  // the archive button is its sibling, first.
  const row = bubble('c').parentElement!
  expect(row.lastElementChild).toBe(bubble('c'))
  expect(row.firstElementChild).toBe(screen.getByRole('button', { name: 'Archive Old taxes' }))
})

test('a question is answered in the full chat too, with no trip to the terminal', async () => {
  cap.transcript.mockResolvedValue({
    sessionId: 'conv',
    offset: 9,
    entries: [
      {
        kind: 'tool',
        id: 'ask1',
        name: 'AskUserQuestion',
        summary: '',
        input: JSON.stringify({
          questions: [
            {
              question: 'Which format?',
              header: 'Format',
              multiSelect: false,
              options: [
                { label: 'PDF', description: '' },
                { label: 'Word', description: '' },
              ],
            },
          ],
        }),
      },
    ],
  })
  const { user } = setup(
    [
      {
        id: 'b',
        name: 'Chief of staff',
        state: 'needs-you',
        waitingFor: 'input needed',
        startedAt: 1,
      },
    ],
    [],
  )
  await user.click(await screen.findByRole('radio', { name: /Word/ }))
  await waitFor(() => expect(typed.fn).toHaveBeenCalledWith(expect.any(String), '\x1b[B\r'))
  expect(screen.queryByRole('button', { name: 'Answer in the terminal' })).toBeNull()
})

test('a screenshot in a message is drawn from the vault, not as a filename', async () => {
  cap.transcript.mockResolvedValue({
    sessionId: 'conv',
    offset: 3,
    entries: [
      {
        kind: 'user',
        id: 'u1',
        text: 'Look @/Users/me/vault/.holi/state/chat.local.uploads/mus3nfro-32b3a6-image.png at this',
      },
    ],
  })
  setup([{ id: 'b', name: 'Chief of staff', state: 'idle', phase: 'done', startedAt: 1 }], [])
  const image = await screen.findByRole('img', { name: 'image.png' })
  expect(image).toHaveAttribute(
    'src',
    'holi-vault://vault/.holi/state/chat.local.uploads/mus3nfro-32b3a6-image.png',
  )
  // A picture that cannot be read back is its name again, not a broken icon.
  fireEvent.error(image)
  expect(await screen.findByText('image.png')).toBeInTheDocument()
  expect(screen.queryByRole('img', { name: 'image.png' })).toBeNull()
})
