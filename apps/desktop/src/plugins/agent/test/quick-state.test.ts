import { describe, expect, it } from 'vitest'
import type { ClaudeRow } from '../main/claude/listing'
import { quickState, START_GRACE_MS } from '../main/host/quick-state'
import {
  DEFAULT_QUICK_HOTKEY,
  hotkeyFromEvent,
  parseGlobalHotkey,
  toAccelerator,
} from '../shared/hotkey'
import { parseQuickRequest, quickPrompt } from '../shared/quick'
import { clampInto, placeAtCursor } from '../main/quick/placement'
import { fitSelection, MAX_SELECTION, readSelection } from '../main/quick/selection'
import { parseQuickSettings } from '../main/quick/settings'

const row = (over: Partial<ClaudeRow>): ClaudeRow => ({ id: 'quick001', name: 'Tidy', ...over })
const live = (over: Partial<ClaudeRow>) => ({
  row: row({ pid: 1, ...over }),
  live: true,
  question: false,
  age: 60_000,
})

describe('quickState', () => {
  it('is a question while Holi holds one, whatever the listing says', () => {
    expect(quickState({ ...live({ status: 'busy' }), question: true })).toBe('question')
  })

  it('is working while busy, on a shell, or idle between readings of a turn', () => {
    expect(quickState(live({ status: 'busy', state: 'working' }))).toBe('working')
    expect(quickState(live({ status: 'shell', state: 'working' }))).toBe('working')
    expect(quickState(live({ status: 'idle', state: 'working' }))).toBe('working')
  })

  it("is the session's own prompt while Claude Code waits on one", () => {
    expect(quickState(live({ status: 'waiting', waitingFor: 'permission prompt' }))).toBe('prompt')
  })

  it('is done when the turn ended, and failed when Claude Code says so', () => {
    expect(quickState(live({ status: 'idle', state: 'done' }))).toBe('done')
    expect(quickState(live({ status: 'idle', state: 'failed' }))).toBe('failed')
  })

  it('counts a process that died mid-turn as failed, once past starting', () => {
    const dead = { row: row({ state: 'working' }), live: false, question: false }
    expect(quickState({ ...dead, age: 100 })).toBe('working')
    expect(quickState({ ...dead, age: START_GRACE_MS + 1 })).toBe('failed')
  })

  it('is gone when stopped, or unlisted after the grace', () => {
    expect(quickState(live({ state: 'stopped' }))).toBe('gone')
    expect(quickState({ row: undefined, live: false, question: false, age: 10 })).toBe('working')
    expect(quickState({ row: undefined, live: false, question: false, age: START_GRACE_MS })).toBe(
      'gone',
    )
  })
})

describe('the global hotkey', () => {
  it('turns glyphs into an accelerator, ⌘ and ⌃ kept apart', () => {
    expect(toAccelerator(DEFAULT_QUICK_HOTKEY)).toBe('Command+J')
    expect(toAccelerator('⌃⌘J')).toBe('Control+Command+J')
    expect(toAccelerator('⌃⌥Space')).toBe('Control+Alt+Space')
    expect(toAccelerator('⌥⇧F5')).toBe('Alt+Shift+F5')
  })

  it('refuses a key every app would lose, and anything it cannot read', () => {
    expect(parseGlobalHotkey('J')).toBeNull()
    expect(parseGlobalHotkey('⇧J')).toBeNull()
    expect(parseGlobalHotkey('⌘')).toBeNull()
    expect(parseGlobalHotkey('⌘JJ')).toBeNull()
    expect(parseGlobalHotkey('⌘⌃J')).toBeNull() // not in macOS's order
  })

  it('records a press by its physical key', () => {
    const press = (over: Partial<Parameters<typeof hotkeyFromEvent>[0]>) =>
      hotkeyFromEvent({
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        code: 'KeyJ',
        key: 'j',
        ...over,
      })
    expect(press({ metaKey: true })).toBe('⌘J')
    // ⌥ changes the character, not the key.
    expect(press({ altKey: true, ctrlKey: true, key: '∆' })).toBe('⌃⌥J')
    expect(press({ metaKey: true, code: 'Space', key: ' ' })).toBe('⌘Space')
    expect(press({})).toBeNull()
    expect(press({ metaKey: true, code: 'MetaLeft', key: 'Meta' })).toBeNull()
  })

  it('reads a settings file key by key', () => {
    expect(parseQuickSettings(null)).toEqual({
      enabled: true,
      hotkey: '⌘J',
      dockHotkey: '⌃⌘J',
      accessibilityAsked: false,
    })
    expect(parseQuickSettings({ enabled: false, hotkey: 'J', accessibilityAsked: true })).toEqual({
      enabled: false,
      hotkey: '⌘J',
      dockHotkey: '⌃⌘J',
      accessibilityAsked: true,
    })
  })
})

describe('placement', () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 }
  const size = { width: 520, height: 132 }

  it('opens just past the pointer', () => {
    expect(placeAtCursor({ x: 300, y: 300 }, size, area)).toEqual({ x: 312, y: 312, ...size })
  })

  it('stays wholly on the display near its edges', () => {
    const r = placeAtCursor({ x: 1430, y: 890 }, size, area)
    expect(r.x + r.width).toBeLessThanOrEqual(area.x + area.width)
    expect(r.y + r.height).toBeLessThanOrEqual(area.y + area.height)
    expect(clampInto({ x: -50, y: -50, ...size }, area)).toMatchObject({ x: 12, y: 37 })
  })

  it('steps past a panel already there', () => {
    const first = placeAtCursor({ x: 300, y: 300 }, size, area)
    const second = placeAtCursor({ x: 300, y: 300 }, size, area, [first])
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height)
  })
})

describe('the selection', () => {
  it('is trimmed, and capped with a note', () => {
    expect(fitSelection('Notes', '\n  hello\n\n')).toEqual({ app: 'Notes', text: '  hello' })
    expect(fitSelection('Notes', '   ')).toBeNull()
    expect(fitSelection('Notes', 'x'.repeat(MAX_SELECTION + 5))?.text).toContain('cut at')
  })

  it('believes an app that answers, and asks one that does not by ⌘C', async () => {
    const answered = fakeRun(['{"app":"Notes","pid":7,"text":"hi"}'])
    expect(await readSelection({ run: answered.run, selfPid: 1 })).toEqual({
      app: 'Notes',
      text: 'hi',
    })
    expect(answered.calls).toBe(1)

    const empty = fakeRun(['{"app":"Notes","pid":7,"text":""}'])
    expect(await readSelection({ run: empty.run, selfPid: 1 })).toBeNull()
    expect(empty.calls).toBe(1)

    const silent = fakeRun(['{"app":"Brave","pid":7}', '{"text":"copied"}'])
    expect(await readSelection({ run: silent.run, selfPid: 1 })).toEqual({
      app: 'Brave',
      text: 'copied',
    })
    expect(silent.calls).toBe(2)
  })

  it('never reads Holi itself, and never throws', async () => {
    const self = fakeRun(['{"app":"Holi","pid":42,"text":"mine"}'])
    expect(await readSelection({ run: self.run, selfPid: 42 })).toBeNull()
    const broken = { run: () => Promise.reject(new Error('osascript')) }
    expect(await readSelection({ run: broken.run, selfPid: 1 })).toBeNull()
  })
})

/** A fake `osascript` answering in turn. */
function fakeRun(outputs: string[]) {
  const fake = {
    calls: 0,
    run: async () => outputs[fake.calls++] ?? '',
  }
  return fake
}

describe('the prompt and the requests', () => {
  it('puts the selection after the task, fenced, with where it came from', () => {
    expect(quickPrompt('  tidy this  ', null)).toBe('tidy this')
    expect(quickPrompt('tidy this', { app: 'Notes', text: 'a\nb' })).toBe(
      'tidy this\n\nSelected in Notes:\n\n```\na\nb\n```',
    )
    expect(quickPrompt('x', { app: 'Notes', text: 'has ```code```' })).toContain('~~~~')
  })

  it('reads only well-formed requests from a page', () => {
    expect(parseQuickRequest({ kind: 'submit', prompt: 'go', selection: true })).toEqual({
      kind: 'submit',
      prompt: 'go',
      selection: true,
    })
    expect(parseQuickRequest({ kind: 'answer', questionId: 'q', answers: { a: 'b' } })).toEqual({
      kind: 'answer',
      questionId: 'q',
      answers: { a: 'b' },
    })
    expect(parseQuickRequest({ kind: 'answer', questionId: 'q', answers: { a: 1 } })).toBeNull()
    expect(parseQuickRequest({ kind: 'size', width: Number.NaN, height: 3 })).toBeNull()
    expect(parseQuickRequest({ kind: 'launch-missiles' })).toBeNull()
    expect(parseQuickRequest('ready')).toBeNull()
  })
})
