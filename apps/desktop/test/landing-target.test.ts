/**
 * What a vault actually opens on, once its `landing` setting has met the vault
 * as it really is.
 *
 * Pure and on plain values, for the reason the whole `lib/` split exists: the
 * decision is arithmetic over "what does the vault hold", and the atom that
 * dispatches it is not the place to test whether a deleted note falls back
 * correctly. Same split as `tab-overflow.ts` and `tab-drop.ts`.
 */
import { describe, expect, test } from 'vitest'
import type { LandingTarget } from '@holi/shared'
import { resolveLanding } from '../src/renderer/src/lib/landing-target'

/** A vault holding one note and one app. */
const vault = {
  docPaths: new Set(['Notes/Standup.md', '22-08-2026.md']),
  appIds: new Set(['retro']),
}

/** A vault holding nothing at all — a freshly created one, before any seeding
 *  the tree can see. */
const empty = { docPaths: new Set<string>(), appIds: new Set<string>() }

const on = (landing: LandingTarget) => ({ landing, dailyNotes: true })
const off = (landing: LandingTarget) => ({ landing, dailyNotes: false })

describe('the daily target', () => {
  test('lands on the daily when the vault keeps one', () => {
    expect(resolveLanding(on({ kind: 'daily' }), vault)).toEqual({ kind: 'daily' })
  })

  test('lands on nothing when the vault does not keep a daily', () => {
    // An empty pane — exactly what a shared vault does today. It looks broken
    // and is not: the vault was asked and said no.
    expect(resolveLanding(off({ kind: 'daily' }), vault)).toBeNull()
  })
})

describe('a target that still exists', () => {
  test('opens the note it names', () => {
    expect(resolveLanding(on({ kind: 'note', path: 'Notes/Standup.md' }), vault)).toEqual({
      kind: 'note',
      path: 'Notes/Standup.md',
    })
  })

  test('opens the app it names', () => {
    expect(resolveLanding(on({ kind: 'app', appId: 'retro' }), vault)).toEqual({
      kind: 'app',
      appId: 'retro',
    })
  })

  test.each(['board', 'agenda', 'mail'] as const)('opens the %s', (kind) => {
    expect(resolveLanding(on({ kind }), vault)).toEqual({ kind })
  })
})

describe('a target that has rotted', () => {
  // A note deleted, or an app removed by a collaborator in a shared vault. The
  // trade D82 already accepted for icons: rot degrades to the ordinary thing,
  // never to an error.
  test('falls back to the daily when the note is gone', () => {
    expect(resolveLanding(on({ kind: 'note', path: 'deleted.md' }), vault)).toEqual({
      kind: 'daily',
    })
  })

  test('falls back to the daily when the app is gone', () => {
    expect(resolveLanding(on({ kind: 'app', appId: 'gone' }), vault)).toEqual({ kind: 'daily' })
  })

  test('falls back in a vault holding nothing at all', () => {
    expect(resolveLanding(on({ kind: 'note', path: 'Notes/Standup.md' }), empty)).toEqual({
      kind: 'daily',
    })
  })

  // ── The one a naive implementation gets wrong ──────────────────────────────
  // The fallback is RE-RESOLUTION, not a hardcoded `{kind:'daily'}`. A vault
  // that said it does not want daily notes must not be handed one just because
  // the thing it asked for is missing.
  test('falls back to NOTHING when the vault keeps no daily either', () => {
    expect(resolveLanding(off({ kind: 'note', path: 'deleted.md' }), vault)).toBeNull()
  })

  test('falls back to nothing for a missing app in a no-daily vault', () => {
    expect(resolveLanding(off({ kind: 'app', appId: 'gone' }), vault)).toBeNull()
  })
})

describe('the singleton surfaces never rot', () => {
  // There is nothing on disk for them to point at, so `dailyNotes` has no
  // bearing on them at all. A vault with daily notes off still opens its board.
  test.each(['board', 'agenda', 'mail'] as const)('%s opens with daily notes off', (kind) => {
    expect(resolveLanding(off({ kind }), empty)).toEqual({ kind })
  })
})

describe('what it hands back', () => {
  test('never returns the settings object it was given', () => {
    // The caller dispatches on this and the settings may be cached; handing back
    // the same object invites a mutation upstream from a later opener.
    const settings = on({ kind: 'note', path: 'Notes/Standup.md' })
    expect(resolveLanding(settings, vault)).not.toBe(settings.landing)
  })
})
