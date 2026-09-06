import { describe, expect, test } from 'vitest'
import { terminalKeyAction, type KeyChord } from '../src/renderer/src/lib/agent-terminal-keys'

/** A keydown with nothing held; each test adds only the modifiers it is about. */
function chord(over: Partial<KeyChord>): KeyChord {
  return {
    type: 'keydown',
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  }
}

describe('the newline chord', () => {
  test('⇧⏎ writes ESC CR, which the Ink input reads as a line break', () => {
    expect(terminalKeyAction(chord({ key: 'Enter', shiftKey: true }), false)).toEqual({
      kind: 'write',
      seq: '\x1b\r',
    })
  })

  test('⏎ alone is left to xterm, so it still submits', () => {
    expect(terminalKeyAction(chord({ key: 'Enter' }), false)).toBeNull()
  })
})

describe('line motion', () => {
  test.each([
    ['ArrowLeft', '\x1b[H'],
    ['ArrowRight', '\x1b[F'],
  ])('⌘%s moves within the current line', (key, seq) => {
    expect(terminalKeyAction(chord({ key, metaKey: true }), false)).toEqual({ kind: 'write', seq })
  })

  test('⌃← is left alone — xterm already encodes Ctrl+arrow as word motion', () => {
    expect(terminalKeyAction(chord({ key: 'ArrowLeft', ctrlKey: true }), false)).toBeNull()
  })

  test('a bare arrow is left alone', () => {
    expect(terminalKeyAction(chord({ key: 'ArrowLeft' }), false)).toBeNull()
  })

  test('⌘⌫ kills to the start of the line', () => {
    expect(terminalKeyAction(chord({ key: 'Backspace', metaKey: true }), false)).toEqual({
      kind: 'write',
      seq: '\x15',
    })
  })

  test('a bare ⌫ is left alone, so it still deletes one character', () => {
    expect(terminalKeyAction(chord({ key: 'Backspace' }), false)).toBeNull()
  })
})

describe('word motion', () => {
  test.each([
    ['ArrowLeft', '\x1bb'],
    ['ArrowRight', '\x1bf'],
    ['Backspace', '\x1b\x7f'],
  ])('⌥%s uses the readline meta binding', (key, seq) => {
    expect(terminalKeyAction(chord({ key, altKey: true }), false)).toEqual({ kind: 'write', seq })
  })
})

describe('the scrollback', () => {
  test.each([
    ['ArrowUp', 'top'],
    ['ArrowDown', 'bottom'],
  ])('⌘%s scrolls xterm rather than writing to the PTY', (key, to) => {
    expect(terminalKeyAction(chord({ key, metaKey: true }), false)).toEqual({ kind: 'scroll', to })
  })
})

describe('the clipboard, and the interrupt it must not swallow', () => {
  test('⌘C with a selection copies', () => {
    expect(terminalKeyAction(chord({ code: 'KeyC', metaKey: true }), true)).toEqual({ kind: 'copy' })
  })

  test('⌘C with NO selection falls through, so the PTY still gets SIGINT', () => {
    expect(terminalKeyAction(chord({ code: 'KeyC', metaKey: true }), false)).toBeNull()
  })

  test('⌃C with no selection falls through too — that is the interrupt on every platform', () => {
    expect(terminalKeyAction(chord({ code: 'KeyC', ctrlKey: true }), false)).toBeNull()
  })

  test('⌘V pastes', () => {
    expect(terminalKeyAction(chord({ code: 'KeyV', metaKey: true }), false)).toEqual({ kind: 'paste' })
  })
})

test('keyup is never acted on — one chord must not fire twice', () => {
  expect(terminalKeyAction(chord({ type: 'keyup', key: 'Enter', shiftKey: true }), false)).toBeNull()
})
