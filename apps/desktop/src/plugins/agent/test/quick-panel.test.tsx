/**
 * The quick panel's page beside the dock: which keys it answers as a request
 * to main, what its foot names, and the size it reports, header and all.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickPanel } from '../renderer/quick/QuickPanel'
import type { QuickRequest, QuickView } from '../shared/quick'

// Claude Code's terminal is xterm's, which jsdom cannot draw.
vi.mock('../renderer/SessionTerminal', () => ({
  SessionTerminal: () => <div data-testid="terminal" />,
}))

type Event = { name: string; payload: unknown }
let listeners = new Set<(event: Event) => void>()
let sent: QuickRequest[] = []

beforeEach(() => {
  listeners = new Set()
  sent = []
  window.holi = {
    // Core's API, which only the vault's theme reads here: it never answers.
    trpc: () => new Promise<never>(() => {}),
    page: {
      on: (cb: (event: Event) => void) => {
        listeners.add(cb)
        return () => void listeners.delete(cb)
      },
      send: (name: string, payload: unknown) => {
        if (name === 'quick') sent.push(payload as QuickRequest)
      },
    },
  } as never
})

const tell = (name: string, payload: unknown) =>
  act(() => listeners.forEach((cb) => cb({ name, payload })))

const agent = (over: Partial<Extract<QuickView, { kind: 'agent' }>> = {}): QuickView => ({
  kind: 'agent',
  remote: 'syv/vault',
  job: 'quick001',
  name: 'Tidy the inbox',
  state: 'working',
  question: null,
  terminalId: null,
  ...over,
})

/** The panel showing `view`, its keys told, with the keyboard or not. */
function open(view: QuickView, focused = true) {
  render(<QuickPanel />)
  tell('quick-hotkey', '⌘J')
  tell('quick-dock-hotkey', '⌃⌘J')
  tell('quick-view', view)
  tell('quick-focus', { focused, user: false })
  sent = []
}

const key = (init: KeyboardEventInit) => fireEvent.keyDown(window, init)
const dockKey = () => key({ key: 'j', code: 'KeyJ', ctrlKey: true, metaKey: true })
const foot = () => document.querySelector('.quick-foot')?.textContent ?? null

describe('the quick panel beside the dock', () => {
  it('steps to the agent above or below on ↑ ↓, and esc puts it away', () => {
    open(agent())
    key({ key: 'ArrowUp' })
    key({ key: 'ArrowDown' })
    // ⇧↑ ⇧↓ scroll an answer: not a step.
    key({ key: 'ArrowDown', shiftKey: true })
    key({ key: 'Escape' })
    expect(sent).toEqual([
      { kind: 'step', dir: -1 },
      { kind: 'step', dir: 1 },
      { kind: 'close-dock' },
    ])
    expect(foot()).toBe('↑↓agentsescclose')
  })

  it('shows no foot on a light without the keyboard', () => {
    open(agent(), false)
    expect(foot()).toBeNull()
  })

  it('opens a finished agent in Holi on ⏎, and clears it on esc or ⌫', () => {
    open(agent({ state: 'done' }))
    expect(foot()).toBe('⏎open in Holi↑↓agentsescclear')
    key({ key: 'Enter' })
    key({ key: 'Escape' })
    key({ key: 'Backspace' })
    expect(sent).toEqual([{ kind: 'open-session' }, { kind: 'clear' }, { kind: 'clear' }])
  })

  it('offers nothing to open for a start that never got a session', () => {
    open(agent({ state: 'failed', job: '', error: 'No vault is open.' }))
    expect(foot()).toBe('↑↓agentsescclear')
    key({ key: 'Enter' })
    expect(sent).toEqual([])
  })

  it("steps into Claude Code's terminal on ⏎, and back out on the dock's key", () => {
    open(agent({ state: 'prompt', terminalId: 'term-1' }))
    const terminal = () => document.querySelector('.quick-terminal')!
    expect(terminal()).toHaveAttribute('data-inside', 'false')
    expect(foot()).toBe('⏎answer in the terminal↑↓agentsescclose')
    key({ key: 'Enter' })
    expect(terminal()).toHaveAttribute('data-inside', 'true')
    expect(foot()).toBe('⌃⌘Jback to the agents')
    // Inside, the keys are Claude Code's.
    key({ key: 'ArrowUp' })
    dockKey()
    expect(terminal()).toHaveAttribute('data-inside', 'false')
    expect(sent).toEqual([])
  })

  it("says to press the dock's key on Claude Code's prompt without the keyboard", () => {
    open(agent({ state: 'prompt', terminalId: 'term-1' }), false)
    expect(foot()).toBe('Press⌃⌘Jto answer')
  })

  it("answers both global keys itself: ⌘J a new agent, the dock's key the dock", () => {
    open(agent())
    key({ key: 'j', code: 'KeyJ', metaKey: true })
    dockKey()
    expect(sent).toEqual([{ kind: 'new' }, { kind: 'dock' }])

    sent = []
    tell('quick-view', { kind: 'prompt', remote: 'syv/vault', selection: null })
    dockKey()
    expect(sent).toEqual([{ kind: 'dock' }])
  })

  it('reports its size with the middle of its header, as each view lands', () => {
    // jsdom lays nothing out: the panel at y 100, its header 19 px tall, 12 px
    // down it.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const header = this.dataset['quickHeader'] !== undefined
      const top = header ? 112 : 100
      const height = header ? 19 : 44
      return { top, height, width: 400, left: 0, right: 400, bottom: top + height, x: 0, y: top }
    } as () => DOMRect)
    try {
      open(agent({ state: 'done' }), false)
      tell('quick-view', agent({ state: 'failed', error: 'It stopped.' }))
      expect(sent.filter((r) => r.kind === 'size').at(-1)).toEqual({
        kind: 'size',
        width: 400,
        height: 44,
        header: 21.5,
      })
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('the card in the quick panel', () => {
  it("leaves ↑ ↓ to the dock, and names the dock's key while it waits", () => {
    const question = {
      id: 'q1',
      job: 'quick001',
      askedAt: 0,
      questions: [
        {
          question: 'Which?',
          multiSelect: false,
          options: [{ label: 'A' }, { label: 'B (Recommended)' }],
        },
      ],
    }
    open(agent({ state: 'question', question }), false)
    expect(foot()).toBe('Press⌃⌘Jto answer')
    tell('quick-focus', { focused: true, user: false })
    key({ key: 'ArrowDown' })
    expect(sent).toEqual([{ kind: 'step', dir: 1 }])
    // ⏎ takes the recommendation, where the highlight started and stayed.
    key({ key: 'Enter' })
    expect(sent.at(-1)).toEqual({
      kind: 'answer',
      questionId: 'q1',
      answers: { 'Which?': 'B (Recommended)' },
    })
    expect(screen.getByRole('option', { name: /B/ })).toHaveAttribute('data-active', 'true')
  })
})
