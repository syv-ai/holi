import { describe, expect, it } from 'vitest'
import {
  TRANSFORM_NAMES,
  VAULT_SETTING_DEFAULTS,
  parseLandingTarget,
  resolveVaultSettings,
} from '../src/vault-settings'

/** The committed file, as JSON text. */
const committed = (value: unknown): string => JSON.stringify(value)

describe('VAULT_SETTING_DEFAULTS', () => {
  it('lands on today’s daily when nothing says otherwise', () => {
    expect(VAULT_SETTING_DEFAULTS.landing).toEqual({ kind: 'daily' })
    expect(VAULT_SETTING_DEFAULTS.dailyNotes).toBe(true)
  })

  it('follows the OS appearance until told otherwise', () => {
    expect(VAULT_SETTING_DEFAULTS.colorScheme).toBe('system')
  })

  it('keeps archive-done opt-in, because it rearranges someone’s work (D76)', () => {
    expect(VAULT_SETTING_DEFAULTS.hooks).toEqual({
      relink: true,
      'archive-done': false,
      'normalize-md': true,
    })
  })

  // The main process keeps its own DEFAULT_MAX_COMMITTED_FILE_BYTES in
  // `vault/large-files.ts`. Two constants that must agree and silently don't is
  // exactly the drift folding the readers into this resolver could introduce.
  it('caps a committed file at the same 10 MB main does', () => {
    expect(VAULT_SETTING_DEFAULTS.maxCommittedFileBytes).toBe(10 * 1024 * 1024)
  })

  it('names every transform the hooks block can carry', () => {
    expect([...TRANSFORM_NAMES].sort()).toEqual(['archive-done', 'normalize-md', 'relink'])
  })
})

describe('resolveVaultSettings — absent and empty files', () => {
  it('resolves to the defaults when neither file exists', () => {
    const s = resolveVaultSettings(null, null)
    expect(s.landing).toEqual({ kind: 'daily' })
    expect(s.dailyNotes).toBe(true)
    expect(s.colorScheme).toBe('system')
    expect(s.hooks).toEqual(VAULT_SETTING_DEFAULTS.hooks)
    expect(s.maxCommittedFileBytes).toBe(VAULT_SETTING_DEFAULTS.maxCommittedFileBytes)
    expect(s.warnings).toEqual([])
  })

  it('treats an empty file as an absent one', () => {
    expect(resolveVaultSettings('', '   ').warnings).toEqual([])
    expect(resolveVaultSettings('', '   ').landing).toEqual({ kind: 'daily' })
  })

  it('never returns the shared defaults object itself', () => {
    // A caller mutating what it got back must not rewrite every later resolve.
    const a = resolveVaultSettings(null, null)
    const b = resolveVaultSettings(null, null)
    expect(a.landing).not.toBe(b.landing)
    expect(a.hooks).not.toBe(b.hooks)
    expect(a.hooks).not.toBe(VAULT_SETTING_DEFAULTS.hooks)
  })
})

describe('resolveVaultSettings — the committed file', () => {
  it('reads every setting from the committed file', () => {
    const s = resolveVaultSettings(
      committed({
        landing: { kind: 'board' },
        dailyNotes: false,
        colorScheme: 'light',
        hooks: { 'archive-done': true },
        maxCommittedFileBytes: 2048,
      }),
      null,
    )
    expect(s.landing).toEqual({ kind: 'board' })
    expect(s.dailyNotes).toBe(false)
    expect(s.colorScheme).toBe('light')
    expect(s.hooks['archive-done']).toBe(true)
    expect(s.maxCommittedFileBytes).toBe(2048)
    expect(s.warnings).toEqual([])
  })

  it('ignores unknown top-level keys silently', () => {
    // `settings.local.json` legitimately carries siblings this resolver knows
    // nothing about — `reminders` is written there by the delivery watermark
    // (main/reminders/delivered-log.ts). Warning about them would fire on every
    // launch of every vault that has ever fired a reminder.
    const s = resolveVaultSettings(null, committed({ reminders: { 'a.md': '2026-08-22T09:00' } }))
    expect(s.warnings).toEqual([])
    expect(s).not.toHaveProperty('reminders')
  })
})

describe('resolveVaultSettings — the local override', () => {
  it('overrides per key, inheriting the rest of the committed file', () => {
    const s = resolveVaultSettings(
      committed({ landing: { kind: 'board' }, dailyNotes: false, colorScheme: 'light' }),
      committed({ colorScheme: 'dark' }),
    )
    expect(s.colorScheme).toBe('dark')
    // Inherited, not wiped out by a one-key local file.
    expect(s.landing).toEqual({ kind: 'board' })
    expect(s.dailyNotes).toBe(false)
  })

  it('merges hooks per transform rather than replacing the block', () => {
    // A local file naming one transform must not silently disable the others.
    const s = resolveVaultSettings(
      committed({ hooks: { relink: true, 'archive-done': true, 'normalize-md': true } }),
      committed({ hooks: { 'archive-done': false } }),
    )
    expect(s.hooks).toEqual({
      relink: true,
      'archive-done': false,
      'normalize-md': true,
    })
  })

  it('lets local win over committed, not the other way round', () => {
    const s = resolveVaultSettings(
      committed({ landing: { kind: 'mail' } }),
      committed({ landing: { kind: 'agenda' } }),
    )
    expect(s.landing).toEqual({ kind: 'agenda' })
  })
})

describe('resolveVaultSettings — malformed input never throws', () => {
  it('ignores a corrupt file and still applies the other one', () => {
    const s = resolveVaultSettings('{ not json', committed({ colorScheme: 'light' }))
    expect(s.colorScheme).toBe('light')
    // The corrupt committed file contributes nothing, not an exception.
    expect(s.landing).toEqual({ kind: 'daily' })
  })

  it('ignores a corrupt local file and keeps the committed one', () => {
    const s = resolveVaultSettings(committed({ dailyNotes: false }), '}}}')
    expect(s.dailyNotes).toBe(false)
  })

  it.each([['"a string"'], ['[1,2,3]'], ['null'], ['42'], ['true']])(
    'treats a non-object top level (%s) as no settings',
    (json) => {
      const s = resolveVaultSettings(json, null)
      expect(s.landing).toEqual({ kind: 'daily' })
      expect(s.dailyNotes).toBe(true)
    },
  )

  it.each([
    ['a non-boolean dailyNotes', { dailyNotes: 'yes' }],
    ['a zero file cap', { maxCommittedFileBytes: 0 }],
    ['a negative file cap', { maxCommittedFileBytes: -1 }],
    ['a non-numeric file cap', { maxCommittedFileBytes: '10mb' }],
    ['an infinite file cap', { maxCommittedFileBytes: Number.POSITIVE_INFINITY }],
    ['an unknown colour scheme', { colorScheme: 'sepia' }],
    ['a non-object hooks block', { hooks: 'all' }],
    ['a non-boolean transform value', { hooks: { relink: 'on' } }],
  ])('falls back to the default for %s, and says so', (_label, value) => {
    const s = resolveVaultSettings(committed(value), null)
    expect(s.warnings.length).toBeGreaterThan(0)
    expect(s.dailyNotes).toBe(true)
    expect(s.colorScheme).toBe('system')
    expect(s.maxCommittedFileBytes).toBe(VAULT_SETTING_DEFAULTS.maxCommittedFileBytes)
    expect(s.hooks.relink).toBe(true)
  })

  it('drops an unknown transform name without disturbing the real ones', () => {
    const s = resolveVaultSettings(committed({ hooks: { 'rm-rf': true } }), null)
    expect(s.hooks).toEqual(VAULT_SETTING_DEFAULTS.hooks)
    expect(s.warnings.length).toBeGreaterThan(0)
  })
})

describe('parseLandingTarget — the trust boundary', () => {
  it.each([
    [{ kind: 'daily' }],
    [{ kind: 'board' }],
    [{ kind: 'agenda' }],
    [{ kind: 'mail' }],
    [{ kind: 'note', path: 'Notes/Standup.md' }],
    [{ kind: 'app', appId: 'retro' }],
  ])('round-trips %j', (value) => {
    expect(parseLandingTarget(value)).toEqual(value)
  })

  it('builds a fresh narrow object rather than passing the input through', () => {
    // Returning the parsed value would let whatever else was in that JSON ride
    // into the workspace. Same rule as parseTabPayload (lib/tab-drop.ts).
    const hostile = { kind: 'note', path: 'a.md', __proto__: { evil: true }, extra: 'x' }
    const parsed = parseLandingTarget(hostile)
    expect(parsed).toEqual({ kind: 'note', path: 'a.md' })
    expect(parsed).not.toBe(hostile)
    expect(parsed).not.toHaveProperty('extra')
  })

  it.each([
    ['an empty note path', { kind: 'note', path: '' }],
    ['a missing note path', { kind: 'note' }],
    ['a non-string note path', { kind: 'note', path: 42 }],
    ['an empty app id', { kind: 'app', appId: '' }],
    ['a missing app id', { kind: 'app' }],
    ['an unknown kind', { kind: 'nowhere' }],
    ['a missing kind', { path: 'a.md' }],
    ['an array', [{ kind: 'daily' }]],
    ['a string', 'daily'],
    ['null', null],
    ['a number', 7],
  ])('refuses %s', (_label, value) => {
    expect(parseLandingTarget(value)).toBeNull()
  })

  it('does not accept a note tab’s preview flag', () => {
    // `landing` is not the renderer's Tab union and must not grow its fields.
    expect(parseLandingTarget({ kind: 'note', path: 'a.md', preview: true })).toEqual({
      kind: 'note',
      path: 'a.md',
    })
  })
})

describe('resolveVaultSettings — landing', () => {
  it('warns and falls back when landing is unusable', () => {
    const s = resolveVaultSettings(committed({ landing: { kind: 'note', path: '' } }), null)
    expect(s.landing).toEqual({ kind: 'daily' })
    expect(s.warnings.length).toBeGreaterThan(0)
  })

  it('keeps a valid committed landing when the local file says nothing about it', () => {
    const s = resolveVaultSettings(
      committed({ landing: { kind: 'app', appId: 'retro' } }),
      committed({ colorScheme: 'dark' }),
    )
    expect(s.landing).toEqual({ kind: 'app', appId: 'retro' })
  })
})
