import { describe, expect, test } from 'vitest'

import { tabSwitch, type TabSwitch } from '../tab-switch'

const order = ['a', 'b', 'c', 'd']
const step = (s: 1 | -1, held = true, active: string | null = 'b') =>
  ({ kind: 'step', step: s, held, order, active }) as const

describe('tabSwitch', () => {
  test('held: Tab steps from the active entry, Shift+Tab back, wrapping; release opens it', () => {
    let state: TabSwitch = tabSwitch(null, step(1)).state
    expect(state).toEqual({ order, at: 2 })
    state = tabSwitch(state, step(1)).state
    state = tabSwitch(state, step(1)).state
    expect(state?.at).toBe(0)
    state = tabSwitch(state, step(-1)).state
    expect(state?.at).toBe(3)
    expect(tabSwitch(state, { kind: 'release' })).toEqual({ state: null, select: 'd' })
  })

  test('Escape cancels without selecting; a click chooses its row', () => {
    const open = tabSwitch(null, step(1)).state
    expect(tabSwitch(open, { kind: 'cancel' })).toEqual({ state: null })
    expect(tabSwitch(open, { kind: 'choose', id: 'a' })).toEqual({ state: null, select: 'a' })
  })

  test('not held (the shortcuts list) it selects the neighbour at once', () => {
    expect(tabSwitch(null, step(-1, false))).toEqual({ state: null, select: 'a' })
  })

  test('nothing to switch to stays closed; a stray release does nothing', () => {
    const one = { kind: 'step', step: 1, held: true, order: ['a'], active: 'a' } as const
    expect(tabSwitch(null, one)).toEqual({ state: null })
    expect(tabSwitch(null, { kind: 'release' })).toEqual({ state: null })
  })
})
