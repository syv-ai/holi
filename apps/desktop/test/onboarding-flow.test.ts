import { describe, expect, it } from 'vitest'
import { VAULT_SETTING_DESCRIPTORS } from '@holi/shared'
import {
  slugify,
  startingAct,
  initialState,
  canAdvance,
  atFloor,
  reduce,
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

  it('advance walks 1→2→3→4→5 and stops', () => {
    const s1 = reduce(s0, { type: 'advance' })
    expect(s1.act).toBe(2)
    // act2 cannot advance without a slug
    expect(reduce(s1, { type: 'advance' }).act).toBe(2)
    const named = reduce(s1, { type: 'setName', name: 'notes' })
    const plugins = reduce(named, { type: 'advance' })
    expect(plugins.act).toBe(3)
    // The plugins and settings acts always advance: every row has a default,
    // so there is nothing to fill in and nothing to block on.
    const settings = reduce(plugins, { type: 'advance' })
    expect(settings.act).toBe(4)
    const threshold = reduce(settings, { type: 'advance' })
    expect(threshold.act).toBe(5)
    // The threshold is the floor of "there is nowhere further".
    expect(reduce(threshold, { type: 'advance' }).act).toBe(5)
  })

  it('canAdvance is true on the plugins and settings acts and false on the threshold', () => {
    expect(canAdvance({ ...s0, act: 3 })).toBe(true)
    expect(canAdvance({ ...s0, act: 4 })).toBe(true)
    expect(canAdvance({ ...s0, act: 5 })).toBe(false)
  })

  it('back walks from the settings act to the plugins act, and on to naming', () => {
    expect(reduce({ ...s0, act: 4 }, { type: 'back', mode: 'first-run' }).act).toBe(3)
    expect(reduce({ ...s0, act: 3 }, { type: 'back', mode: 'first-run' }).act).toBe(2)
  })

  it('back floors at startingAct and toggles out of join first', () => {
    const atJoin = reduce(reduce(s0, { type: 'advance' }), { type: 'toJoin' })
    expect(reduce(atJoin, { type: 'back', mode: 'first-run' }).view).toBe('form')
    expect(reduce(s0, { type: 'back', mode: 'first-run' }).act).toBe(1) // already floor
    expect(reduce({ ...s0, act: 2 }, { type: 'back', mode: 'add-vault' }).act).toBe(2) // add-vault floor
  })

  it('created advances to the PLUGINS act and clears the pending state', () => {
    // The vault exists by here: the plugins and settings acts write into it.
    const naming = reduce(reduce(s0, { type: 'advance' }), { type: 'setName', name: 'notes' })
    const submitting = reduce(naming, { type: 'submitStart' })
    const done = reduce(submitting, { type: 'created' })
    expect(done).toMatchObject({ act: 3, submitting: false, error: null })
    expect(reduce(done, { type: 'advance' }).act).toBe(4)
  })

  it('failInPlace shows the error without leaving the current act/view (join adopt)', () => {
    const onJoin = reduce(reduce(s0, { type: 'advance' }), { type: 'toJoin' })
    const failed = reduce(
      { ...onJoin, submitting: true },
      { type: 'failInPlace', error: 'no push' },
    )
    expect(failed).toMatchObject({ act: 2, view: 'join', submitting: false, error: 'no push' })
  })

  it('atFloor is true only on the form at the starting act', () => {
    expect(atFloor(initialState('add-vault', 'x'), 'add-vault')).toBe(true)
    expect(atFloor({ ...initialState('add-vault', 'x'), view: 'join' }, 'add-vault')).toBe(false)
  })
})

describe('the settings the ritual collects', () => {
  const s0 = initialState('first-run', 'nthomsencph')

  it('starts from the descriptors’ own defaults', () => {
    // Click straight through and the vault gets exactly what the seed wrote —
    // the write is a no-op in effect, not a second opinion about the defaults.
    for (const d of VAULT_SETTING_DESCRIPTORS) {
      expect(s0.settings[d.key]).toEqual(d.default)
    }
  })

  it('records an answer without disturbing unrelated ones', () => {
    const answered = reduce(s0, { type: 'setSetting', key: 'colorScheme', value: 'dark' })
    expect(answered.settings.colorScheme).toBe('dark')
    expect(answered.settings.dailyNotes).toEqual(s0.settings.dailyNotes)
    expect(answered.settings.home).toEqual(s0.settings.home)
  })

  it('moves Home off today’s note when its option is withdrawn', () => {
    // Turning daily notes off takes "today's note" off the Home row. Leaving
    // the answer there would leave a value the user can neither see nor change.
    const daily = reduce(s0, { type: 'setSetting', key: 'home', value: 'daily' })
    const off = reduce(daily, { type: 'setSetting', key: 'dailyNotes', value: false })
    expect(off.settings.home).not.toBe('daily')
  })

  it('leaves a Home that is still on offer', () => {
    const chosen = reduce(s0, { type: 'setSetting', key: 'home', value: 'mail' })
    const off = reduce(chosen, { type: 'setSetting', key: 'dailyNotes', value: false })
    expect(off.settings.home).toBe('mail')
  })

  it('takes the last answer when one is changed twice', () => {
    const once = reduce(s0, { type: 'setSetting', key: 'colorScheme', value: 'dark' })
    const twice = reduce(once, { type: 'setSetting', key: 'colorScheme', value: 'light' })
    expect(twice.settings.colorScheme).toBe('light')
  })

  it('does not mutate the state it was given', () => {
    const answered = reduce(s0, { type: 'setSetting', key: 'dailyNotes', value: false })
    expect(s0.settings.dailyNotes).toBe(true)
    expect(answered.settings).not.toBe(s0.settings)
  })

  it('add-vault collects them too', () => {
    // A second vault is asked the same questions as the first — it is a vault,
    // not an afterthought.
    const added = initialState('add-vault', 'nthomsencph')
    expect(Object.keys(added.settings).sort()).toEqual(
      VAULT_SETTING_DESCRIPTORS.map((d) => d.key).sort(),
    )
  })
})

describe('plugins', () => {
  const s0 = initialState('first-run', 'ada')
  const pluginsOf = (s: ReturnType<typeof initialState>) =>
    s.settings.plugins as { vault: Record<string, boolean>; localOff: string[] }

  it('records a plugin turned away from its default', () => {
    const off = reduce(s0, { type: 'setPlugin', id: 'pdf', on: false, byDefault: true })
    expect(pluginsOf(off).vault).toEqual({ pdf: false })
  })

  it('records nothing for a plugin back on its default, so a later default still reaches it', () => {
    const off = reduce(s0, { type: 'setPlugin', id: 'pdf', on: false, byDefault: true })
    const back = reduce(off, { type: 'setPlugin', id: 'pdf', on: true, byDefault: true })
    expect(pluginsOf(back).vault).toEqual({})
  })
})
