import { describe, expect, it } from 'vitest'
import {
  TRANSFORM_NAMES,
  VAULT_SETTING_DEFAULTS,
  VAULT_SETTING_DESCRIPTORS,
  parseLandingTarget,
  parseSettingsPatch,
  resolveVaultSettings,
  seedSettings,
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

describe('VAULT_SETTING_DESCRIPTORS', () => {
  // The list is what the onboarding act renders AND what the seed writes. Both
  // read it, so a row that is wrong here is wrong in two places at once.

  it('describes a setting the resolver actually answers', () => {
    for (const d of VAULT_SETTING_DESCRIPTORS) {
      expect(VAULT_SETTING_DEFAULTS).toHaveProperty(d.key)
    }
  })

  it('takes its default from the resolver rather than restating it', () => {
    for (const d of VAULT_SETTING_DESCRIPTORS) {
      expect(d.default).toEqual(VAULT_SETTING_DEFAULTS[d.key])
    }
  })

  it('tells the user where every setting lives afterwards', () => {
    // Carried as data so a row structurally cannot ship without one — a step
    // that changes something and does not say where to change it later is a
    // dead end for the person who wants to change their mind.
    for (const d of VAULT_SETTING_DESCRIPTORS) {
      expect(d.whereToChange.length).toBeGreaterThan(0)
      expect(d.label.length).toBeGreaterThan(0)
      expect(d.explanation.length).toBeGreaterThan(0)
    }
  })

  it('writes each row to exactly one of the two files', () => {
    for (const d of VAULT_SETTING_DESCRIPTORS) {
      expect(['committed', 'local']).toContain(d.target)
    }
  })

  it('keeps appearance machine-local and everything else in the vault', () => {
    // A teammate's committed choice flipping your app to light mode is exactly
    // the failure the `.local` layer exists to prevent.
    const local = VAULT_SETTING_DESCRIPTORS.filter((d) => d.target === 'local').map((d) => d.key)
    expect(local).toEqual(['colorScheme'])
  })

  it('names no key twice', () => {
    const keys = VAULT_SETTING_DESCRIPTORS.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('offers only landing targets a brand-new vault can express', () => {
    // No notes and no apps exist yet, so the step cannot offer them. Pointing
    // `landing` at either stays a file edit.
    const landing = VAULT_SETTING_DESCRIPTORS.find((d) => d.key === 'landing')!
    expect(landing.control.kind).toBe('choice')
    const values =
      landing.control.kind === 'choice'
        ? landing.control.options.map((o) => (o.value as { kind: string }).kind)
        : []
    expect(values).toEqual(['daily', 'board', 'agenda', 'mail'])
  })

  it('offers every colour scheme the resolver accepts', () => {
    const scheme = VAULT_SETTING_DESCRIPTORS.find((d) => d.key === 'colorScheme')!
    const values =
      scheme.control.kind === 'choice' ? scheme.control.options.map((o) => o.value) : []
    expect(values).toEqual(['system', 'light', 'dark'])
  })

  it('groups the commit transforms under one heading, naming all three', () => {
    const hooks = VAULT_SETTING_DESCRIPTORS.find((d) => d.key === 'hooks')!
    expect(hooks.control.kind).toBe('group')
    const named = hooks.control.kind === 'group' ? hooks.control.toggles.map((t) => t.key) : []
    expect([...named].sort()).toEqual([...TRANSFORM_NAMES].sort())
  })
})

describe('seedSettings', () => {
  it('writes the committed rows into the vault’s settings file', () => {
    const seeded = seedSettings('committed')
    expect(Object.keys(seeded).sort()).toEqual(['dailyNotes', 'hooks', 'landing'])
  })

  it('still declares every transform D76 expects, with archive-done off', () => {
    // The seed used to be a hand-written literal. If a descriptor drops a
    // transform, the seed silently stops declaring it and the vault inherits a
    // default it never stated.
    expect(seedSettings('committed').hooks).toEqual({
      relink: true,
      'archive-done': false,
      'normalize-md': true,
    })
  })

  it('writes appearance to the machine-local file, alone', () => {
    expect(seedSettings('local')).toEqual({ colorScheme: 'system' })
  })

  it('seeds nothing the onboarding step does not ask about', () => {
    // `maxCommittedFileBytes` has no descriptor on purpose: freezing it into
    // every vault would mean raising the default later never reaches the vaults
    // that already exist.
    expect(seedSettings('committed')).not.toHaveProperty('maxCommittedFileBytes')
  })

  it('round-trips through the resolver to exactly the defaults', () => {
    // The strongest statement the seed can make: a freshly seeded vault behaves
    // identically to one with no settings files at all.
    const resolved = resolveVaultSettings(
      JSON.stringify(seedSettings('committed')),
      JSON.stringify(seedSettings('local')),
    )
    expect(resolved.warnings).toEqual([])
    expect(resolved.landing).toEqual(VAULT_SETTING_DEFAULTS.landing)
    expect(resolved.dailyNotes).toBe(VAULT_SETTING_DEFAULTS.dailyNotes)
    expect(resolved.colorScheme).toBe(VAULT_SETTING_DEFAULTS.colorScheme)
    expect(resolved.hooks).toEqual(VAULT_SETTING_DEFAULTS.hooks)
  })
})

describe('parseSettingsPatch — the write-side trust boundary', () => {
  // A read RESOLVES: every key answered, defaults filled in. A write must not
  // do that — writing a full object would stamp defaults over keys the user
  // never touched. So a patch carries only what was actually answered.

  it('keeps the keys it was given and invents none', () => {
    const { patch } = parseSettingsPatch(JSON.stringify({ dailyNotes: false }))
    expect(patch).toEqual({ dailyNotes: false })
  })

  it('validates a landing target exactly as a read does', () => {
    const { patch } = parseSettingsPatch(
      JSON.stringify({ landing: { kind: 'note', path: 'a.md', extra: 'x' } }),
    )
    expect(patch.landing).toEqual({ kind: 'note', path: 'a.md' })
  })

  it.each([
    ['an unusable landing target', { landing: { kind: 'note', path: '' } }],
    ['a non-boolean dailyNotes', { dailyNotes: 'yes' }],
    ['an unknown colour scheme', { colorScheme: 'sepia' }],
    ['a non-object hooks block', { hooks: 'all' }],
    ['a file cap of zero', { maxCommittedFileBytes: 0 }],
  ])('drops %s rather than writing it, and says so', (_label, value) => {
    const { patch, warnings } = parseSettingsPatch(JSON.stringify(value))
    expect(patch).toEqual({})
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('drops keys it does not own', () => {
    // Asymmetric with the read on purpose. A read TOLERATES siblings it does
    // not own — `reminders` lives in the local file and must survive. A write
    // must not be able to CREATE one: that would make this procedure a way for
    // the renderer to put arbitrary JSON into a committed, synced file.
    const { patch } = parseSettingsPatch(
      JSON.stringify({ dailyNotes: true, reminders: { 'a.md': 'x' }, nonsense: 1 }),
    )
    expect(patch).toEqual({ dailyNotes: true })
  })

  it('keeps only the transforms it knows, and only boolean answers', () => {
    const { patch } = parseSettingsPatch(
      JSON.stringify({ hooks: { relink: false, 'rm-rf': true, 'normalize-md': 'yes' } }),
    )
    expect(patch.hooks).toEqual({ relink: false })
  })

  it('drops a hooks block that survives nothing', () => {
    const { patch } = parseSettingsPatch(JSON.stringify({ hooks: { 'rm-rf': true } }))
    expect(patch).toEqual({})
  })

  it.each([[null], ['{ not json'], ['[]'], ['"a string"'], ['42']])(
    'treats unusable input (%s) as an empty patch',
    (json) => {
      expect(parseSettingsPatch(json).patch).toEqual({})
    },
  )

  it('accepts everything the seed writes', () => {
    // The step sends back what the descriptors offered, so a patch of the
    // defaults must survive the boundary intact or the step cannot save.
    expect(parseSettingsPatch(JSON.stringify(seedSettings('committed'))).patch).toEqual(
      seedSettings('committed'),
    )
    expect(parseSettingsPatch(JSON.stringify(seedSettings('local'))).patch).toEqual(
      seedSettings('local'),
    )
  })
})
