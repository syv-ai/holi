import { describe, expect, it } from 'vitest'
import { MAX_COMMAND_TEXT, commandActionOf } from '../shared/commands'

describe('commandActionOf', () => {
  it('reads text as a replace, and nothing as nothing', () => {
    expect(commandActionOf('HELLO')).toEqual({ replace: 'HELLO' })
    expect(commandActionOf(undefined)).toBeNull()
    expect(commandActionOf(null)).toBeNull()
  })

  it('keeps each action', () => {
    for (const action of [{ replace: '' }, { insert: 'x' }, { open: 'a.md' }, { agent: 'go' }]) {
      expect(commandActionOf(action)).toEqual(action)
    }
  })

  it('refuses any other shape, with a reason', () => {
    for (const value of [
      42,
      ['x'],
      {},
      { replace: 'a', insert: 'b' },
      { delete: 'x' },
      { insert: 3 },
      { open: ' ' },
      { agent: '' },
      'x'.repeat(MAX_COMMAND_TEXT + 1),
    ]) {
      expect(commandActionOf(value)).toHaveProperty('error')
    }
  })
})
