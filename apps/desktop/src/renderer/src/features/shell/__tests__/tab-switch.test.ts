import { describe, expect, test } from 'vitest'

import { tabSwitch, type TabSwitch } from '../tab-switch'

// Most recently used first, as the shell hands it over: 'now' is in front.
const order = ['now', 'before', 'older', 'oldest']
const step = (s: 1 | -1, held = true, active: string | null = 'now') =>
  ({ kind: 'step', step: s, held, order, active }) as const

describe('tabSwitch', () => {
  test('held: the first Tab marks the tab used before, Shift+Tab goes back, wrapping', () => {
    let state: TabSwitch = tabSwitch(null, step(1)).state
    expect(state).toEqual({ order, at: 1 })
    state = tabSwitch(state, step(1)).state
    state = tabSwitch(state, step(1)).state
    expect(state?.at).toBe(3)
    state = tabSwitch(state, step(1)).state
    expect(state?.at).toBe(0)
    state = tabSwitch(state, step(-1)).state
    expect(tabSwitch(state, { kind: 'release', order })).toEqual({ state: null, select: 'oldest' })
  })

  test('a quick ⌃Tab and let go is the tab used before', () => {
    const open = tabSwitch(null, step(1)).state
    expect(tabSwitch(open, { kind: 'release', order })).toEqual({ state: null, select: 'before' })
  })

  test('Escape cancels without selecting; a click chooses its row', () => {
    const open = tabSwitch(null, step(1)).state
    expect(tabSwitch(open, { kind: 'cancel' })).toEqual({ state: null })
    expect(tabSwitch(open, { kind: 'choose', id: 'older', order })).toEqual({
      state: null,
      select: 'older',
    })
  })

  test('not held (the shortcuts list) it selects at once', () => {
    expect(tabSwitch(null, step(1, false))).toEqual({ state: null, select: 'before' })
  })

  test('nothing to switch to stays closed; a stray release does nothing', () => {
    const one = { kind: 'step', step: 1, held: true, order: ['now'], active: 'now' } as const
    expect(tabSwitch(null, one)).toEqual({ state: null })
    expect(tabSwitch(null, { kind: 'release', order })).toEqual({ state: null })
  })

  test('a tab closed while switching opens nothing on release', () => {
    const open = tabSwitch(null, step(1)).state
    expect(tabSwitch(open, { kind: 'release', order: ['now', 'older'] })).toEqual({ state: null })
  })

  test('opened by a click it stays open past a release, and Enter opens the one selected', () => {
    let state = tabSwitch(null, { kind: 'open', order, active: 'now' }).state
    expect(state).toEqual({ order, at: 1, pinned: true })
    expect(tabSwitch(state, { kind: 'release', order }).state).toBe(state)
    state = tabSwitch(state, step(1)).state
    expect(tabSwitch(state, { kind: 'commit', order })).toEqual({ state: null, select: 'older' })
  })
})
