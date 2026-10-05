/**
 * What the agents say when you are elsewhere: a smaller chat from a bubble,
 * and notifications in the top right for an answer that is ready or an agent
 * that needs you.
 */
import { render, screen, waitFor, within } from '@/test/render'
import { act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom, openSurfaceAtom, surfaceActiveAtom } from '@/plugin-api'
import { AgentBubbles } from '../renderer/AgentBubbles'
import { lastAnswer, pendingTool, plainPreview } from '../../agent/renderer/lib/preview'
import {
  ANSWER_NOTICE_MS,
  agentNoticesAtom,
  quickChatAtom,
  watchNotices,
} from '../../agent/renderer/state/notices'
import {
  agentHistoryAtom,
  agentSessionsAtom,
  agentViewAtom,
  overviewSelectionAtom,
  type AgentSession,
} from '../../agent/renderer/state/sessions'

const cap = vi.hoisted(() => ({
  open: vi.fn(),
  say: vi.fn(),
  transcript: vi.fn(),
  question: vi.fn(),
  upload: vi.fn(),
}))
vi.mock('../../agent/renderer/agent-cap', () => ({
  agentCap: {
    open: (_remote: string, args: unknown) => cap.open(args),
    say: (_remote: string, args: unknown) => cap.say(args),
    transcript: (_remote: string, args: unknown) => cap.transcript(args),
    question: (_remote: string, args: unknown) => cap.question(args),
    upload: (_remote: string, args: unknown) => cap.upload(args),
  },
}))
const typed = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../../agent/renderer/lib/session-terminals', async (original) => ({
  ...(await original<typeof import('../../agent/renderer/lib/session-terminals')>()),
  typeIntoTerminal: (_remote: string, id: string, data: string) => typed.fn(id, data),
}))

const ANSWER = {
  sessionId: 'conv',
  offset: 5,
  entries: [
    { kind: 'user', id: 'u1', text: 'Book it' },
    {
      kind: 'assistant',
      id: 'a1',
      text: 'Done. **Booked** the 9:40 flight, see [the receipt](http://x).',
    },
  ],
}

beforeEach(() => {
  for (const fn of Object.values(cap)) fn.mockReset()
  typed.fn.mockReset()
  cap.open.mockResolvedValue({ ok: true, terminalId: 't-a' })
  cap.say.mockResolvedValue({ ok: true, terminalId: 't-a' })
  cap.transcript.mockResolvedValue(ANSWER)
  cap.question.mockResolvedValue(null)
})
afterEach(() => vi.useRealTimers())

const session = (over: Partial<AgentSession> & { id: string }): AgentSession => ({
  name: `Session ${over.id}`,
  state: 'idle',
  phase: 'done',
  startedAt: 1,
  ...over,
})

function previewTests(): void {
  test('a preview is plain words: no marks, links as their text, at most a glance', () => {
    expect(plainPreview('Done. **Booked** `it`, see [the receipt](http://x).')).toBe(
      'Done. Booked it, see the receipt.',
    )
    expect(plainPreview('# Title\n\n- one\n- two')).toBe('Title one two')
    expect(plainPreview('```js\ncode\n```\nafter')).toBe('after')
    const long = plainPreview('word '.repeat(200))
    expect(long.length).toBeLessThanOrEqual(241)
    expect(long.endsWith('…')).toBe(true)
  })

  test('the answer is the last thing said, and none if a message came after it', () => {
    expect(lastAnswer(ANSWER.entries as never)).toBe(
      'Done. Booked the 9:40 flight, see the receipt.',
    )
    expect(lastAnswer([...ANSWER.entries, { kind: 'user', id: 'u2', text: 'and?' }] as never)).toBe(
      '',
    )
    expect(lastAnswer([])).toBe('')
  })

  test('the pending tool is the last call with no result yet', () => {
    const entries = [
      { kind: 'tool', id: 't1', name: 'Read', summary: 'a.md', input: '{}' },
      { kind: 'tool-result', id: 't1', ok: true, text: 'x' },
      { kind: 'tool', id: 't2', name: 'Bash', summary: 'rm -rf build', input: '{}' },
    ]
    expect(pendingTool(entries as never)).toBe('Bash: rm -rf build')
    expect(pendingTool(entries.slice(0, 2) as never)).toBe('')
  })
}

previewTests()

function watching(sessions: AgentSession[]) {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/vault')
  store.set(agentSessionsAtom, sessions)
  const stop = watchNotices('o/vault', store)
  return { store, stop }
}

test('an answer that is ready is announced, with what it said', async () => {
  const { store } = watching([session({ id: 'a', state: 'working' })])
  store.set(agentSessionsAtom, [session({ id: 'a' })])
  await waitFor(() => expect(store.get(agentNoticesAtom)).toHaveLength(1))
  expect(store.get(agentNoticesAtom)[0]).toMatchObject({
    sessionId: 'a',
    kind: 'answer',
    preview: 'Done. Booked the 9:40 flight, see the receipt.',
  })
})

test('what was already running when the vault opened is not news', async () => {
  const { store } = watching([session({ id: 'a', state: 'working' })])
  await new Promise((r) => setTimeout(r, 20))
  expect(store.get(agentNoticesAtom)).toEqual([])
})

test('an agent that needs you is announced with the call it asks to run, and goes when answered', async () => {
  cap.transcript.mockResolvedValue({
    ...ANSWER,
    entries: [{ kind: 'tool', id: 't2', name: 'Bash', summary: 'ls flights', input: '{}' }],
  })
  const { store } = watching([session({ id: 'a', state: 'working' })])
  store.set(agentSessionsAtom, [
    session({ id: 'a', state: 'needs-you', waitingFor: 'permission prompt' }),
  ])
  await waitFor(() => expect(store.get(agentNoticesAtom)).toHaveLength(1))
  expect(store.get(agentNoticesAtom)[0]).toMatchObject({
    kind: 'needs-you',
    waitingFor: 'permission prompt',
    tool: 'Bash: ls flights',
  })
  // It was answered: its question is moot.
  store.set(agentSessionsAtom, [session({ id: 'a', state: 'working' })])
  expect(store.get(agentNoticesAtom)).toEqual([])
})

test('nothing is announced about the chat you are looking at, or one whose small chat is open', async () => {
  const { store } = watching([
    session({ id: 'a', state: 'working' }),
    session({ id: 'b', state: 'working' }),
  ])
  // The agents page, on a.
  store.set(openSurfaceAtom, 'agent')
  store.set(overviewSelectionAtom, 'a')
  store.set(agentViewAtom, 'chat')
  // The small chat, on b.
  store.set(quickChatAtom, 'b')
  store.set(agentSessionsAtom, [session({ id: 'a' }), session({ id: 'b' })])
  await new Promise((r) => setTimeout(r, 30))
  expect(store.get(agentNoticesAtom).map((n) => n.sessionId)).not.toContain('b')
})

function ui(sessions: AgentSession[], opts: { history?: boolean } = {}) {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/vault')
  store.set(agentSessionsAtom, sessions)
  if (opts.history)
    store.set(agentHistoryAtom, [{ id: 'p', name: 'Old one', phase: 'done', startedAt: 0 }])
  render(
    <Provider store={store}>
      <AgentBubbles />
    </Provider>,
  )
  return { store, user: userEvent.setup() }
}
const bubble = (id: string) => document.querySelector<HTMLElement>(`[data-agent-bubble="${id}"]`)!

test('a bubble opens a smaller chat from any page but the agents', async () => {
  const { store, user } = ui([session({ id: 'a', name: 'Travel agent' })])
  await user.click(bubble('a'))
  expect(store.get(quickChatAtom)).toBe('a')
  const quick = document.querySelector<HTMLElement>('[data-quick-chat="a"]')!
  // Its last answer, and a box.
  expect(await within(quick).findByText(/Booked/)).toBeInTheDocument()
  expect(within(quick).getByRole('textbox', { name: 'Message' })).toHaveFocus()
  // Not the full page.
  expect(store.get(overviewSelectionAtom)).toBeNull()
})

test('the words of a row open the full chat and go to the agents page; the face does not', async () => {
  const { store, user } = ui([session({ id: 'a', name: 'Travel agent' })])
  expect(store.get(surfaceActiveAtom('agent'))).toBe(false)

  // The face: the small chat, and the page stays where it is.
  await user.click(bubble('a'))
  expect(store.get(quickChatAtom)).toBe('a')
  expect(store.get(surfaceActiveAtom('agent'))).toBe(false)
  act(() => store.set(quickChatAtom, null))

  // The words: the full chat, on its own page.
  await user.click(document.querySelector<HTMLElement>('[data-agent-open="a"]')!)
  expect(store.get(overviewSelectionAtom)).toBe('a')
  expect(store.get(surfaceActiveAtom('agent'))).toBe(true)
  expect(store.get(quickChatAtom)).toBeNull()
})

test('writing in it sends the message and closes it', async () => {
  const { store, user } = ui([session({ id: 'a' })])
  await user.click(bubble('a'))
  const box = await screen.findByRole('textbox', { name: 'Message' })
  await user.type(box, 'And a hotel{Enter}')
  expect(cap.say).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', text: 'And a hotel' }))
  await waitFor(() => expect(store.get(quickChatAtom)).toBeNull())
  expect(document.querySelector('[data-quick-chat]')).toBeNull()
})

test('a message it cannot send stays in the box, with why', async () => {
  cap.say.mockResolvedValue({ ok: false, message: 'That session has ended.' })
  const { store, user } = ui([session({ id: 'a' })])
  await user.click(bubble('a'))
  const box = await screen.findByRole('textbox', { name: 'Message' })
  await user.type(box, 'hello{Enter}')
  expect(await screen.findByText('That session has ended.')).toBeInTheDocument()
  expect(box).toHaveValue('hello')
  expect(store.get(quickChatAtom)).toBe('a')
})

test('the face takes you to the full page, and closing sends nothing', async () => {
  const { store, user } = ui([session({ id: 'a', name: 'Travel agent' })])
  await user.click(bubble('a'))
  await user.click(
    await screen.findByRole('button', { name: 'Open the full chat with Travel agent' }),
  )
  expect(store.get(overviewSelectionAtom)).toBe('a')
  expect(store.get(quickChatAtom)).toBeNull()

  // (The full page is the agents page now, so a bubble would pick, not open
  // the small chat: open it as a bubble does elsewhere.)
  act(() => store.set(quickChatAtom, 'a'))
  await user.click(await screen.findByRole('button', { name: 'Close' }))
  expect(store.get(quickChatAtom)).toBeNull()
  expect(cap.say).not.toHaveBeenCalled()
})

test('a session that needs you takes no message in the small chat', async () => {
  const { user } = ui([session({ id: 'a', state: 'needs-you', waitingFor: 'permission prompt' })])
  await user.click(bubble('a'))
  expect(await screen.findByRole('textbox', { name: 'Message' })).toBeDisabled()
})

const ASKED = (questions: unknown, extra: unknown[] = []) => ({
  sessionId: 'conv',
  offset: 9,
  entries: [
    { kind: 'user', id: 'u1', text: 'Plan it' },
    {
      kind: 'tool',
      id: 'ask1',
      name: 'AskUserQuestion',
      summary: '',
      input: JSON.stringify({ questions }),
    },
    ...extra,
  ],
})
const FORMAT = {
  question: 'Which format?',
  header: 'Format',
  multiSelect: false,
  options: [
    { label: 'PDF', description: 'Fixed layout' },
    { label: 'Word', description: 'Editable' },
  ],
}

test('a permission prompt is answered in the small chat, on the call it asks about', async () => {
  cap.transcript.mockResolvedValue({
    sessionId: 'conv',
    offset: 9,
    entries: [{ kind: 'tool', id: 't1', name: 'Bash', summary: 'ls -la', input: '{}' }],
  })
  const { user } = ui([session({ id: 'a', state: 'needs-you', waitingFor: 'permission prompt' })])
  await user.click(bubble('a'))
  const card = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-quick-needs-you="permission"]')
    expect(el).not.toBeNull()
    return el!
  })
  expect(await within(card).findByText('Bash: ls -la')).toBeInTheDocument()
  await user.click(within(card).getByRole('button', { name: 'Allow' }))
  await waitFor(() => expect(typed.fn).toHaveBeenCalledWith('t-a', '\r'))
  await user.click(within(card).getByRole('button', { name: 'Deny' }))
  await waitFor(() => expect(typed.fn).toHaveBeenCalledWith('t-a', '\x1b'), { timeout: 3000 })
})

test('a question is drawn with its options, and a choice presses the keys that pick it', async () => {
  cap.transcript.mockResolvedValue(ASKED([FORMAT]))
  const { user } = ui([session({ id: 'a', state: 'needs-you', waitingFor: 'input needed' })])
  await user.click(bubble('a'))
  expect(await screen.findByText('Which format?')).toBeInTheDocument()
  expect(screen.getByText('Fixed layout')).toBeInTheDocument()
  await user.click(screen.getByRole('radio', { name: /Word/ }))
  // Second option: one step down, then Enter.
  await waitFor(() => expect(typed.fn).toHaveBeenCalledWith('t-a', '\x1b[B\r'))
})

test('several questions are walked one at a time, then sent together', async () => {
  cap.transcript.mockResolvedValue(
    ASKED([
      FORMAT,
      { ...FORMAT, question: 'How often?', options: [{ label: 'Daily', description: '' }] },
    ]),
  )
  const { user } = ui([session({ id: 'a', state: 'needs-you', waitingFor: 'input needed' })])
  await user.click(bubble('a'))
  await user.click(await screen.findByRole('radio', { name: /Word/ }))
  expect(typed.fn).not.toHaveBeenCalled()
  await user.click(await screen.findByRole('radio', { name: /Daily/ }))
  // (Each press opens a terminal here: the mock never registers one.)
  await waitFor(() => expect(typed.fn).toHaveBeenCalledTimes(3), { timeout: 5000 })
  expect(typed.fn.mock.calls.map((c) => c[1])).toEqual(['\x1b[B\r', '\r', '\r'])
})

test('a multiple-choice question toggles its options with Space, then Enter', async () => {
  cap.transcript.mockResolvedValue(
    ASKED([
      {
        question: 'Which extras?',
        header: 'Extras',
        multiSelect: true,
        options: [
          { label: 'A', description: '' },
          { label: 'B', description: '' },
          { label: 'C', description: '' },
        ],
      },
    ]),
  )
  const { user } = ui([session({ id: 'a', state: 'needs-you', waitingFor: 'input needed' })])
  await user.click(bubble('a'))
  await user.click(await screen.findByRole('checkbox', { name: 'A' }))
  await user.click(screen.getByRole('checkbox', { name: 'C' }))
  expect(typed.fn).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Send answer' }))
  await waitFor(() => expect(typed.fn).toHaveBeenCalledTimes(3), { timeout: 5000 })
  // A (already under the cursor), two down to C, then confirm.
  expect(typed.fn.mock.calls.map((c) => c[1])).toEqual([' ', '\x1b[B\x1b[B ', '\r'])
})

test('the person’s own words go through the dialog’s Other row', async () => {
  cap.transcript.mockResolvedValue(ASKED([FORMAT]))
  const { user } = ui([session({ id: 'a', state: 'needs-you', waitingFor: 'input needed' })])
  await user.click(bubble('a'))
  await user.click(await screen.findByRole('button', { name: 'Write another answer' }))
  await user.type(screen.getByRole('textbox', { name: 'Which format?' }), 'Markdown{Enter}')
  await waitFor(() => expect(typed.fn).toHaveBeenCalledTimes(3), { timeout: 5000 })
  // Past the two options to Other, the words, Enter.
  expect(typed.fn.mock.calls.map((c) => c[1])).toEqual(['\x1b[B\x1b[B', 'Markdown', '\r'])
})

test('a question not yet in the transcript is waited for, not handed over', async () => {
  cap.transcript.mockResolvedValue({ sessionId: 'conv', offset: 1, entries: [] })
  const { store, user } = ui([session({ id: 'a', state: 'needs-you', waitingFor: 'input needed' })])
  await user.click(bubble('a'))
  expect(await screen.findByText('Reading its question…')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Open the full chat' })).toBeNull()
  expect(store.get(overviewSelectionAtom)).toBeNull()
})

test('a question only the job record has is drawn, and can be cancelled', async () => {
  cap.transcript.mockResolvedValue({ sessionId: 'conv', offset: 1, entries: [] })
  cap.question.mockResolvedValue(JSON.stringify({ questions: [FORMAT] }))
  const { user } = ui([session({ id: 'a', state: 'needs-you', waitingFor: 'input needed' })])
  await user.click(bubble('a'))
  expect(await screen.findByText('Which format?')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(typed.fn).toHaveBeenCalledWith('t-a', '\x1b'))
})

test('a question nobody can read is waited for a while, then the terminal is offered', async () => {
  cap.transcript.mockResolvedValue({ sessionId: 'conv', offset: 1, entries: [] })
  const { user } = ui([session({ id: 'a', state: 'needs-you', waitingFor: 'input needed' })])
  await user.click(bubble('a'))
  expect(await screen.findByText('Reading its question…')).toBeInTheDocument()
  expect(
    await screen.findByRole('button', { name: 'Open the full chat' }, { timeout: 6000 }),
  ).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(typed.fn).toHaveBeenCalledWith('t-a', '\x1b'))
}, 10000)

test('a dialog it cannot read at all is offered the full chat, only when pressed', async () => {
  const { store, user } = ui([session({ id: 'a', state: 'needs-you', waitingFor: 'dialog open' })])
  await user.click(bubble('a'))
  // Still the small chat until the person asks.
  expect(store.get(quickChatAtom)).toBe('a')
  expect(store.get(overviewSelectionAtom)).toBeNull()
  await user.click(await screen.findByRole('button', { name: 'Open the full chat' }))
  expect(store.get(overviewSelectionAtom)).toBe('a')
})

test('the small chat shows a short summary, and only says that a turn is running', async () => {
  cap.transcript.mockResolvedValue({
    sessionId: 'conv',
    offset: 9,
    entries: [{ kind: 'assistant', id: 'a1', text: '**Booked** it. '.repeat(80) }],
  })
  const { store, user } = ui([session({ id: 'a' })])
  await user.click(bubble('a'))
  const summary = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-quick-chat-summary]')
    expect(el).not.toBeNull()
    return el!
  })
  expect(summary.className).toContain('line-clamp-3')
  expect(summary.textContent).not.toContain('**')
  expect(summary.textContent!.length).toBeLessThanOrEqual(241)
  act(() => store.set(agentSessionsAtom, [session({ id: 'a', state: 'working' })]))
  expect(await screen.findByText('Working…')).toBeInTheDocument()
  expect(document.querySelector('[data-quick-chat-summary]')).toBeNull()
})

test('a finished chat has only its full page', async () => {
  const { store, user } = ui([session({ id: 'a' })], { history: true })
  await user.click(bubble('p'))
  expect(store.get(quickChatAtom)).toBeNull()
  expect(store.get(overviewSelectionAtom)).toBe('p')
})

function notified(notice: Partial<import('../../agent/renderer/state/notices').AgentNotice>) {
  const r = ui([session({ id: 'a', name: 'Travel agent' })])
  act(() =>
    r.store.set(agentNoticesAtom, [
      {
        id: 'a:answer',
        sessionId: 'a',
        name: 'Travel agent',
        kind: 'answer',
        preview: 'Booked the 9:40 flight.',
        tool: '',
        ...notice,
      },
    ]),
  )
  return r
}
const card = () => document.querySelector<HTMLElement>('[data-agent-notice]')!

test('an answer that is ready pops up with its first words, and opens in full when pressed', async () => {
  const { store, user } = notified({})
  expect(within(card()).getByText('Answer ready')).toBeInTheDocument()
  expect(within(card()).getByText('Booked the 9:40 flight.')).toBeInTheDocument()
  await user.click(within(card()).getByRole('button', { name: 'Open Travel agent' }))
  expect(store.get(overviewSelectionAtom)).toBe('a')
  // Read: nothing left to announce.
  expect(store.get(agentNoticesAtom)).toEqual([])
})

test('a notification is dismissed with its cross', async () => {
  const { store, user } = notified({})
  await user.click(within(card()).getByRole('button', { name: 'Dismiss' }))
  expect(store.get(agentNoticesAtom)).toEqual([])
  expect(store.get(overviewSelectionAtom)).toBeNull()
})

test('an answer goes by itself after a while', () => {
  vi.useFakeTimers()
  const { store } = notified({})
  act(() => vi.advanceTimersByTime(ANSWER_NOTICE_MS + 10))
  expect(store.get(agentNoticesAtom)).toEqual([])
})

test('a permission prompt is answered on its notification, without leaving the page', async () => {
  const { store, user } = notified({
    id: 'a:needs-you',
    kind: 'needs-you',
    waitingFor: 'permission prompt',
    tool: 'Bash: ls flights',
    preview: '',
  })
  expect(within(card()).getByText('Approval required')).toBeInTheDocument()
  expect(within(card()).getByText('Bash: ls flights')).toBeInTheDocument()
  await user.click(within(card()).getByRole('button', { name: 'Allow' }))
  await waitFor(() => expect(typed.fn).toHaveBeenCalledWith('t-a', '\r'))
  await waitFor(() => expect(store.get(agentNoticesAtom)).toEqual([]))
  // Still where it was.
  expect(store.get(overviewSelectionAtom)).toBeNull()
})

test('it can be denied there too, and a question of any other kind is answered in full', async () => {
  const { store, user } = notified({
    id: 'a:needs-you',
    kind: 'needs-you',
    waitingFor: 'permission prompt',
    tool: 'Bash: rm -rf build',
    preview: '',
  })
  await user.click(within(card()).getByRole('button', { name: 'Deny' }))
  await waitFor(() => expect(typed.fn).toHaveBeenCalledWith('t-a', '\x1b'))
  act(() =>
    store.set(agentNoticesAtom, [
      {
        id: 'a:needs-you',
        sessionId: 'a',
        name: 'Travel agent',
        kind: 'needs-you',
        waitingFor: 'input needed',
        preview: '',
        tool: '',
      },
    ]),
  )
  expect(within(card()).queryByRole('button', { name: 'Allow' })).toBeNull()
  await user.click(within(card()).getByRole('button', { name: 'Answer' }))
  expect(store.get(overviewSelectionAtom)).toBe('a')
})

const PNG = () => new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' })

test('a screenshot pasted into the small chat waits above the box as a picture, and goes with the message', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:shot')
  URL.revokeObjectURL = vi.fn()
  const upload = vi.fn().mockResolvedValue({
    ok: true,
    path: '/v/.holi/state/chat.local.uploads/abc-123456-image.png',
  })
  cap.upload = upload
  const { store, user } = ui([session({ id: 'a' })])
  await user.click(bubble('a'))
  const box = await screen.findByRole('textbox', { name: 'Message' })
  box.focus()
  await user.paste({ files: [PNG()], getData: () => '', types: ['Files'] } as never)
  const strip = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-quick-chat-files]')
    expect(el).not.toBeNull()
    return el!
  })
  expect(within(strip).getByRole('img')).toHaveAttribute('src', 'blob:shot')

  // A picture alone is a message.
  await user.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(cap.say).toHaveBeenCalledTimes(1))
  expect(cap.say).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'a',
      text: '@/v/.holi/state/chat.local.uploads/abc-123456-image.png',
    }),
  )
  await waitFor(() => expect(store.get(quickChatAtom)).toBeNull())
})

test('a picture can be taken back before it is sent', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:shot')
  URL.revokeObjectURL = vi.fn()
  const { user } = ui([session({ id: 'a' })])
  await user.click(bubble('a'))
  const box = await screen.findByRole('textbox', { name: 'Message' })
  box.focus()
  await user.paste({ files: [PNG()], getData: () => '', types: ['Files'] } as never)
  await user.click(await screen.findByRole('button', { name: /^Remove / }))
  expect(document.querySelector('[data-quick-chat-files]')).toBeNull()
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
})
