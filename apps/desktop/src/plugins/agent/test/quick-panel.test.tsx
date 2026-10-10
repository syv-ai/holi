/**
 * The quick panel's page: the prompt's one line and its draft, and beside the
 * dock which keys it answers as a request to main, each naming its agent.
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
  id: '1',
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
      { kind: 'step', dir: -1, agent: '1' },
      { kind: 'step', dir: 1, agent: '1' },
      { kind: 'hide' },
    ])
    expect(foot()).toBe('↑↓agentsescclose')
  })

  it('opens a finished agent in Holi on ⏎, and clears it on esc or ⌫', () => {
    open(agent({ state: 'done' }))
    expect(foot()).toBe('⏎open in Holi↑↓agentsescclear')
    key({ key: 'Enter' })
    key({ key: 'Escape' })
    key({ key: 'Backspace' })
    expect(sent).toEqual([
      { kind: 'open-session', agent: '1' },
      { kind: 'clear', agent: '1' },
      { kind: 'clear', agent: '1' },
    ])
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

  it("answers both global keys itself: ⌘J a new agent, the dock's key the dock", () => {
    open(agent())
    key({ key: 'j', code: 'KeyJ', metaKey: true })
    dockKey()
    expect(sent).toEqual([{ kind: 'new' }, { kind: 'dock' }])

    sent = []
    tell('quick-view', { kind: 'prompt', id: 1, remote: 'syv/vault', selection: null })
    dockKey()
    expect(sent).toEqual([{ kind: 'dock' }])
  })
})

describe('the prompt', () => {
  const prompt = (selection: { app: string; text: string } | null, id = 1): QuickView => ({
    kind: 'prompt',
    id,
    remote: 'syv/vault',
    selection,
  })
  const field = () => screen.getByRole('textbox', { name: 'What should the agent do?' })
  const tag = () => document.querySelector('[data-quick-selection]')?.textContent ?? null
  const submits = () => sent.filter((r) => r.kind === 'submit')

  it("is one line: the task, the selection's app and the vault, its keys unnamed", () => {
    open(prompt({ app: 'Safari', text: 'A paragraph.' }))
    expect(foot()).toBeNull()
    expect(tag()).toBe('Safari')
    expect(document.querySelector('.quick-meta')?.textContent).toBe('vault')
    fireEvent.change(field(), { target: { value: 'Summarise it' } })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(submits()).toEqual([{ kind: 'submit', prompt: 'Summarise it', selection: true }])
  })

  it('drops the selection on ⌫ in the empty field', () => {
    open(prompt({ app: 'Safari', text: 'A paragraph.' }))
    fireEvent.keyDown(field(), { key: 'Backspace' })
    expect(tag()).toBeNull()
    fireEvent.change(field(), { target: { value: 'Tidy the inbox' } })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(submits()).toEqual([{ kind: 'submit', prompt: 'Tidy the inbox', selection: false }])
  })

  it('keeps its draft while the panel shows an agent, and a new prompt starts empty', () => {
    open(prompt(null))
    fireEvent.change(field(), { target: { value: 'Half a thought' } })
    tell('quick-view', agent())
    tell('quick-view', prompt(null))
    expect(field()).toHaveValue('Half a thought')
    tell('quick-view', prompt(null, 2))
    expect(field()).toHaveValue('')
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
    expect(sent).toEqual([{ kind: 'step', dir: 1, agent: '1' }])
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
