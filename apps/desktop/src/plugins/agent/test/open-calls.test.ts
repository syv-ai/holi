/**
 * Which call a waiting session's prompt is about: only ever the one call its
 * current turn has open. More than one, or none, and nothing can say.
 */
import { describe, expect, it } from 'vitest'
import { openCalls, soleOpenCall } from '../shared/open-calls'

const tool = (id: string) => ({ kind: 'tool', id })
const result = (id: string) => ({ kind: 'tool-result', id })

describe('open calls', () => {
  it('is the call with no result yet', () => {
    const entries = [tool('t1'), result('t1'), tool('t2')]
    expect(openCalls(entries)).toEqual(['t2'])
    expect(soleOpenCall(entries)).toBe('t2')
  })

  it('reads a chat item’s folded result the same way', () => {
    expect(openCalls([{ ...tool('t1'), result: { ok: true } }, tool('t2')])).toEqual(['t2'])
  })

  it('cannot say which of two calls running at once a prompt is about', () => {
    const entries = [tool('t1'), tool('t2')]
    expect(openCalls(entries)).toEqual(['t1', 't2'])
    expect(soleOpenCall(entries)).toBeNull()
  })

  it('counts only the current turn: an older call left without a result is not it', () => {
    for (const boundary of ['user', 'turn-end', 'interrupt']) {
      const entries = [tool('old'), { kind: boundary, id: 'b' }, tool('now')]
      expect(soleOpenCall(entries)).toBe('now')
    }
  })

  it('does not take a message typed while the agent works for a new turn', () => {
    const entries = [tool('t1'), { kind: 'user', id: 'q', queued: true }]
    expect(soleOpenCall(entries)).toBe('t1')
  })

  it('is nothing when every call has its result', () => {
    expect(soleOpenCall([tool('t1'), result('t1')])).toBeNull()
  })
})
