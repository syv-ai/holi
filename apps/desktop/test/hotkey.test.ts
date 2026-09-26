import { describe, expect, it } from 'vitest'
import { matchHotkey, parseHotkey } from '../src/renderer/src/lib/hotkey'

const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: '', ...init }) as KeyboardEvent

describe('parseHotkey', () => {
  it('reads glyph modifiers and the trailing key', () => {
    expect(parseHotkey('⌘J')).toEqual({ mod: true, shift: false, alt: false, key: 'j' })
    expect(parseHotkey('⌘⇧D')).toEqual({ mod: true, shift: true, alt: false, key: 'd' })
  })
})

describe('matchHotkey', () => {
  it('matches the platform modifier as Meta OR Ctrl', () => {
    expect(matchHotkey(ev({ metaKey: true, key: 'j' }), '⌘J')).toBe(true)
    expect(matchHotkey(ev({ ctrlKey: true, key: 'j' }), '⌘J')).toBe(true)
  })
  it('requires the modifier', () => {
    expect(matchHotkey(ev({ key: 'j' }), '⌘J')).toBe(false)
  })
  it('is exact on shift — ⌘J does not fire on ⌘⇧J', () => {
    expect(matchHotkey(ev({ metaKey: true, shiftKey: true, key: 'j' }), '⌘J')).toBe(false)
    expect(matchHotkey(ev({ metaKey: true, shiftKey: true, key: 'd' }), '⌘⇧D')).toBe(true)
  })
  it('is case-insensitive on the key', () => {
    expect(matchHotkey(ev({ metaKey: true, key: 'J' }), '⌘J')).toBe(true)
  })
  it('matches ⌥ shortcuts by physical key, since ⌥ changes the character', () => {
    // macOS: ⌥⌘S reports `ß` as its key.
    const e = ev({ metaKey: true, altKey: true, key: 'ß', code: 'KeyS' })
    expect(matchHotkey(e, '⌥⌘S')).toBe(true)
    expect(matchHotkey(e, '⌘S')).toBe(false)
  })
  it('without ⌥, the letter decides, not the physical key (AZERTY)', () => {
    expect(matchHotkey(ev({ metaKey: true, key: 'q', code: 'KeyA' }), '⌘A')).toBe(false)
  })
})
