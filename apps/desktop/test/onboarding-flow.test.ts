import { describe, expect, it } from 'vitest'
import {
  slugify,
  startingAct,
  initialState,
  canAdvance,
  atFloor,
  reduce
} from '../src/renderer/src/state/onboarding-flow'

describe('slugify', () => {
  it('lowercases, dashes non-alnum, collapses and trims', () => {
    expect(slugify('  Q2 Planning!! ')).toBe('q2-planning')
    expect(slugify('a--_--b')).toBe('a-b')
    expect(slugify('')).toBe('')
  })
})

describe('startingAct', () => {
  it('first-run starts at 1, add-vault at 2', () => {
    expect(startingAct('first-run')).toBe(1)
    expect(startingAct('add-vault')).toBe(2)
  })
})

describe('reduce', () => {
  const s0 = initialState('first-run', 'nthomsencph')

  it('advance walks 1→2→3 and stops', () => {
    const s1 = reduce(s0, { type: 'advance' })
    expect(s1.act).toBe(2)
    // act2 cannot advance without a slug
    expect(reduce(s1, { type: 'advance' }).act).toBe(2)
    const named = reduce(s1, { type: 'setName', name: 'notes' })
    expect(reduce(named, { type: 'advance' }).act).toBe(3)
  })

  it('back floors at startingAct and toggles out of join first', () => {
    const atJoin = reduce(reduce(s0, { type: 'advance' }), { type: 'toJoin' })
    expect(reduce(atJoin, { type: 'back', mode: 'first-run' }).view).toBe('form')
    expect(reduce(s0, { type: 'back', mode: 'first-run' }).act).toBe(1) // already floor
    expect(reduce({ ...s0, act: 2 }, { type: 'back', mode: 'add-vault' }).act).toBe(2) // add-vault floor
  })

  it('fail bounces to the naming act with the message', () => {
    const failed = reduce({ ...s0, act: 3, submitting: true }, { type: 'fail', error: 'nope' })
    expect(failed).toMatchObject({ act: 2, view: 'form', submitting: false, error: 'nope' })
  })

  it('atFloor is true only on the form at the starting act', () => {
    expect(atFloor(initialState('add-vault', 'x'), 'add-vault')).toBe(true)
    expect(atFloor({ ...initialState('add-vault', 'x'), view: 'join' }, 'add-vault')).toBe(false)
  })
})
