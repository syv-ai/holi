/**
 * The chat's list: a window of the latest items that reveals earlier ones
 * without moving the view, a follow of the end that lets go of a person who
 * scrolls up, and the footer that says what could not be placed.
 */
import { render, screen } from '@/test/render'
import { act, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ChatContext, ChatItem, AgentSession } from '../../agent/renderer/public'
import { ChatView, INITIAL_ITEMS, MORE_ITEMS } from '../renderer/chat/ChatView'
import { resetRowErrors } from '../renderer/chat/rows/RowBoundary'

const transcript = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  loadEarlier: vi.fn(),
}))
vi.mock('../../agent/renderer/chat/use-transcript', () => ({
  useTranscript: () => transcript.state,
  useQuestions: () => null,
}))
const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('motion/react', async (original) => ({
  ...(await original<typeof import('motion/react')>()),
  useReducedMotion: () => motion.reduced,
}))
vi.mock('../../agent/renderer/SessionTerminal', () => ({ SessionTerminal: () => <div /> }))
vi.mock('../renderer/chat/rows/ToolCard', () => ({
  ToolCard: ({ item }: { item: { name: string } }) => <div>{`tool:${item.name}`}</div>,
}))

const ctx: ChatContext = { tasks: new Map(), loadSubagent: async () => null, sessionId: 's1' }
const SESSION: AgentSession = {
  id: 's1',
  name: 'Travel',
  state: 'idle',
  phase: 'done',
  startedAt: 1,
}

const say = (n: number): ChatItem[] =>
  Array.from({ length: n }, (_, i) => ({ kind: 'user', id: `m${i}`, text: `message ${i}` }))

function setTranscript(items: ChatItem[], extra: Record<string, unknown> = {}): void {
  transcript.state = {
    items,
    tasks: new Map(),
    ctx,
    loaded: true,
    error: null,
    refresh: () => {},
    drift: { unknownShapes: [], total: items.length, oversize: 0, unparseable: 0 },
    canLoadEarlier: false,
    loadingEarlier: false,
    loadEarlier: transcript.loadEarlier,
    loadSubagent: async () => null,
    ...extra,
  }
}

const bubbles = () => [...document.querySelectorAll('[data-chat-user]')].map((b) => b.textContent)
const earlier = () => document.querySelector<HTMLElement>('[data-chat-earlier]')
const scroller = () => document.querySelector<HTMLElement>('[data-chat-scroll]')!

const written: string[] = []
beforeEach(() => {
  written.length = 0
  transcript.loadEarlier.mockReset()
  transcript.loadEarlier.mockResolvedValue(undefined)
  resetRowErrors()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t: string) => (written.push(t), Promise.resolve()) },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  motion.reduced = false
})

test('500 items show the latest 150 and a control for the rest', () => {
  setTranscript(say(500))
  render(<ChatView session={SESSION} visible />)
  expect(bubbles()).toHaveLength(INITIAL_ITEMS)
  expect(bubbles()[0]).toBe('message 350')
  expect(bubbles().at(-1)).toBe('message 499')
  expect(earlier()).toHaveTextContent('Show earlier (350)')
})

test('"Show earlier" reveals a page more and the view keeps its place', () => {
  setTranscript(say(500))
  render(<ChatView session={SESSION} visible />)
  const el = scroller()
  // 26px for each row drawn above the first of the window.
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => 5000 + (bubbles().length - INITIAL_ITEMS) * 26,
  })
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: 40 })
  // Revealing grows the list above the view; the view moves down by as much.
  const open = earlier()!
  fireEvent.click(open)
  // The browser may already have moved it: the view is put where it should
  // be either way.
  expect(bubbles()).toHaveLength(INITIAL_ITEMS + MORE_ITEMS)
  expect(bubbles()[0]).toBe('message 250')
  expect(el.scrollTop).toBe(40 + 2600)
  expect(earlier()).toHaveTextContent('Show earlier (250)')
})

test('what arrives at the end joins the window without pushing the top out', () => {
  setTranscript(say(500))
  const { rerender } = render(<ChatView session={SESSION} visible />)
  setTranscript(say(503))
  rerender(<ChatView session={SESSION} visible />)
  expect(bubbles()).toHaveLength(INITIAL_ITEMS + 3)
  expect(bubbles()[0]).toBe('message 350')
})

test('a short conversation has no control and shows everything', () => {
  setTranscript(say(40))
  render(<ChatView session={SESSION} visible />)
  expect(bubbles()).toHaveLength(40)
  expect(earlier()).toBeNull()
})

test('with everything loaded shown, the control loads the part before and reveals it', async () => {
  setTranscript(say(100), { canLoadEarlier: true })
  const { rerender } = render(<ChatView session={SESSION} visible />)
  expect(earlier()).toHaveTextContent('Load earlier')
  await act(async () => void fireEvent.click(earlier()!))
  expect(transcript.loadEarlier).toHaveBeenCalledTimes(1)
  // 300 earlier items arrive in front.
  const before = say(300).map((m, i) => ({ ...m, id: `old${i}`, text: `old ${i}` }))
  setTranscript([...before, ...say(100)], { canLoadEarlier: true })
  rerender(<ChatView session={SESSION} visible />)
  expect(bubbles()).toHaveLength(100 + MORE_ITEMS)
  expect(bubbles()[0]).toBe('old 200')
  expect(earlier()).toHaveTextContent('Show earlier (200)')
})

test('the control says so while the earlier part is being read', () => {
  setTranscript(say(100), { canLoadEarlier: true, loadingEarlier: true })
  render(<ChatView session={SESSION} visible />)
  expect(earlier()).toHaveTextContent('Loading earlier…')
  expect(earlier()).toHaveAttribute('aria-busy', 'true')
})

// ── following the end ───────────────────────────────────────────────────

let observers: { callback: () => void; targets: Element[] }[] = []
class FakeResizeObserver {
  entry: { callback: () => void; targets: Element[] }
  constructor(callback: () => void) {
    this.entry = { callback, targets: [] }
    observers.push(this.entry)
  }
  observe(target: Element): void {
    this.entry.targets.push(target)
  }
  unobserve(): void {}
  disconnect(): void {
    observers = observers.filter((o) => o !== this.entry)
  }
}

function geometry(el: HTMLElement, state: { height: number; top: number }): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => state.height })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.top,
    set: (v: number) => void (state.top = v),
  })
}
const resize = () => act(() => void observers.forEach((o) => o.callback()))

test('it stays at the end as the content grows, and lets go of a person who scrolls up', () => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  setTranscript(say(5))
  render(<ChatView session={SESSION} visible />)
  const el = scroller()
  const state = { height: 1000, top: 600 }
  geometry(el, state)
  expect(observers.some((o) => o.targets.includes(el))).toBe(true)

  // A row opens, a picture loads: the end moves and the view goes with it.
  state.height = 1300
  resize()
  expect(state.top).toBe(1300)
  fireEvent.scroll(el)
  expect(document.querySelector('[data-chat-jump]')).toBeNull()

  // The person scrolls up to read.
  state.top = 300
  fireEvent.scroll(el)
  state.height = 1700
  resize()
  expect(state.top).toBe(300)
  expect(document.querySelector('[data-chat-jump]')).toHaveTextContent('Jump to latest')

  // Back to the end by hand: no pill, and following again.
  state.top = 1700 - 400
  fireEvent.scroll(el)
  expect(document.querySelector('[data-chat-jump]')).toBeNull()
  state.height = 1900
  resize()
  expect(state.top).toBe(1900)
})

test('"Jump to latest" goes to the end and follows again', () => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  setTranscript(say(5))
  render(<ChatView session={SESSION} visible />)
  const el = scroller()
  const state = { height: 1000, top: 600 }
  geometry(el, state)
  const scrollTo = vi.fn((arg: ScrollToOptions) => void (state.top = arg.top ?? 0))
  el.scrollTo = scrollTo as unknown as typeof el.scrollTo
  fireEvent.scroll(el)
  state.top = 100
  fireEvent.scroll(el)
  state.height = 1400
  resize()
  const pill = document.querySelector<HTMLElement>('[data-chat-jump]')!
  fireEvent.click(pill)
  expect(scrollTo).toHaveBeenCalledWith({ top: 1400, behavior: 'smooth' })
  expect(document.querySelector('[data-chat-jump]')).toBeNull()
  state.height = 1600
  resize()
  expect(state.top).toBe(1600)
})

test('a reduced-motion setting makes the jump instant', () => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  motion.reduced = true
  setTranscript(say(5))
  render(<ChatView session={SESSION} visible />)
  const el = scroller()
  const state = { height: 1000, top: 600 }
  geometry(el, state)
  const scrollTo = vi.fn()
  el.scrollTo = scrollTo as unknown as typeof el.scrollTo
  fireEvent.scroll(el)
  state.top = 100
  fireEvent.scroll(el)
  state.height = 1400
  resize()
  fireEvent.click(document.querySelector('[data-chat-jump]')!)
  expect(scrollTo).not.toHaveBeenCalled()
  expect(state.top).toBe(1400)
})

test('showing earlier items does not raise the jump pill', () => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  setTranscript(say(500))
  render(<ChatView session={SESSION} visible />)
  const el = scroller()
  const state = { height: 5000, top: 40 }
  geometry(el, state)
  fireEvent.click(earlier()!)
  state.height = 7600
  resize()
  expect(document.querySelector('[data-chat-jump]')).toBeNull()
})

// ── what could not be placed ────────────────────────────────────────────

test('there is no footer when everything was placed', () => {
  setTranscript(say(3))
  render(<ChatView session={SESSION} visible />)
  expect(document.querySelector('[data-chat-drift]')).toBeNull()
})

test('the footer counts what was not recognised and copies only signatures', () => {
  const secret = 'the launch code is 0000'
  setTranscript([{ kind: 'user', id: 'u', text: secret }, ...say(2)], {
    drift: {
      unknownShapes: [
        { shape: 'system:new-thing{a,b}', count: 2 },
        { shape: 'attachment:other', count: 1 },
      ],
      total: 90,
      oversize: 0,
      unparseable: 0,
    },
  })
  render(<ChatView session={SESSION} visible />)
  expect(document.querySelector('[data-chat-drift]')).toHaveTextContent(
    '3 parts of this conversation were not recognised',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
  expect(written).toHaveLength(1)
  expect(written[0]).toContain('system:new-thing{a,b} x2')
  expect(written[0]).toContain('attachment:other x1')
  expect(written[0]).not.toContain(secret)
  expect(written[0]).not.toContain('message 0')
})

test('the diagnostics carry the Claude Code version that wrote what was not placed', () => {
  setTranscript(
    [{ kind: 'unknown', id: 'x', shape: 'weird', raw: '{"private":"text"}', version: '2.1.99' }],
    {
      drift: {
        unknownShapes: [{ shape: 'weird', count: 1 }],
        total: 5,
        oversize: 0,
        unparseable: 0,
      },
    },
  )
  render(<ChatView session={SESSION} visible />)
  expect(document.querySelector('[data-chat-drift]')).toHaveTextContent(
    '1 part of this conversation was not recognised',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
  expect(written[0]).toContain('Claude Code: 2.1.99')
  expect(written[0]).not.toContain('private')
})

test('a row that cannot be drawn counts toward the footer', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  setTranscript([{ kind: 'user', id: 'bad', text: 7 as unknown as string }, ...say(1)])
  render(<ChatView session={SESSION} visible />)
  expect(screen.getByText('This part could not be shown')).toBeInTheDocument()
  expect(document.querySelector('[data-chat-drift]')).toHaveTextContent(
    '1 part of this conversation was not recognised',
  )
  expect(bubbles()).toEqual(['message 0'])
})

// ── what it kept ────────────────────────────────────────────────────────

test('the working dots, the empty note and the read error are still drawn', () => {
  setTranscript([], { loaded: true })
  const { rerender } = render(<ChatView session={SESSION} visible />)
  expect(screen.getByText('Nothing said yet. Tell it what you want done.')).toBeInTheDocument()
  setTranscript(say(1))
  rerender(<ChatView session={{ ...SESSION, state: 'working' }} visible />)
  expect(document.querySelector('[data-chat-working]')).not.toBeNull()
  setTranscript([], { error: 'no file' })
  rerender(<ChatView session={SESSION} visible />)
  expect(document.querySelector('[data-chat-unread]')).toHaveTextContent('no file')
})

test('a thought is open while it is the last row of a turn in progress', () => {
  setTranscript([{ kind: 'thinking', id: 'k', text: 'Weighing options' }])
  const { rerender } = render(<ChatView session={{ ...SESSION, state: 'working' }} visible />)
  expect(screen.getByText('Weighing options')).toBeInTheDocument()
  setTranscript([
    { kind: 'thinking', id: 'k', text: 'Weighing options' },
    { kind: 'assistant', id: 'a', text: 'Done.' },
  ])
  rerender(<ChatView session={{ ...SESSION, state: 'working' }} visible />)
  expect(document.querySelector('[data-chat-row="thinking"]')).not.toBeNull()
})
