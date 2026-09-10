/**
 * A settings file that explains itself, and survives being written to.
 *
 * The format change is only worth anything if two things hold: the file carries
 * the explanations, and writing to it does not throw them away. The second is
 * the one that would fail silently and permanently — a stringify-based writer
 * looks perfect until the first time somebody changes a setting, and by then
 * the comments are gone from disk.
 */
import { describe, expect, it } from 'vitest'
import {
  VAULT_SETTINGS,
  parseSettingsText,
  resolveVaultSettings,
  seedSettings,
  seedSettingsText,
  writeSettingsText,
} from '../src/index'

describe('a seeded settings file', () => {
  const seeded = seedSettingsText(seedSettings('committed'))

  it('explains every key it carries, in the tab’s own words', () => {
    for (const setting of VAULT_SETTINGS) {
      if (!(setting.key in seedSettings('committed'))) continue
      expect(seeded, setting.key).toContain(`# ${setting.label}`)
      expect(seeded, setting.key).toContain(`# ${setting.explanation}`)
    }
  })

  it('is block YAML, not a single flow mapping', () => {
    // `parseDocument('{}')` preserves the flow style it was given, which put
    // every key on one line and stacked the comments at the top.
    expect(seeded.startsWith('{')).toBe(false)
    expect(seeded).toMatch(/^hooks:\n {2}relink: true$/m)
  })

  it('resolves to exactly the defaults, like the JSON it replaces', () => {
    const resolved = resolveVaultSettings(seeded, null)
    expect(resolved.warnings).toEqual([])
    expect(resolved.dailyNotes).toBe(true)
    expect(resolved.landing).toEqual({ kind: 'daily' })
  })
})

describe('writing to a settings file', () => {
  it('keeps a comment somebody wrote by hand', () => {
    // The property the whole module exists for. A writer that stringified the
    // values would delete this on the first click of any control, once, with no
    // way back.
    const mine = '# my own note, do not lose this\ndailyNotes: true\n'
    expect(writeSettingsText(mine, { dailyNotes: false })).toContain(
      '# my own note, do not lose this',
    )
  })

  it('does not add a second copy of an explanation it already wrote', () => {
    const seeded = seedSettingsText(seedSettings('committed'))
    const written = writeSettingsText(seeded, { dailyNotes: false })
    const label = VAULT_SETTINGS.find((s) => s.key === 'dailyNotes')!.label
    expect(written.split(`# ${label}`)).toHaveLength(2)
  })

  it('explains a key it adds for the first time', () => {
    const written = writeSettingsText('dailyNotes: true\n', { editorFont: 'serif' })
    expect(written).toContain('# Notes are set in')
    expect(written).toContain('editorFont: serif')
  })

  it('leaves alone a key no setting describes', () => {
    // `reminders` is the delivery watermark, written into the local file by
    // main. It is machine state and has nothing to explain.
    const written = writeSettingsText('reminders:\n  seen: 3\n', { colorScheme: 'dark' })
    expect(written).toContain('seen: 3')
    expect(parseSettingsText(written).reminders).toEqual({ seen: 3 })
  })

  it('replaces a file whose top level is not a mapping', () => {
    // Refusing forever would leave the pane unable to fix a file somebody broke.
    expect(parseSettingsText(writeSettingsText('- a\n- b\n', { dailyNotes: false }))).toEqual({
      dailyNotes: false,
    })
  })
})

describe('the old JSON still reads', () => {
  it('parses, because YAML is a superset of it', () => {
    // What lets the migration rename without translating, and what stops a
    // vault caught mid-migration from being unreadable.
    const json = '{"dailyNotes": false, "editorFont": "serif"}'
    expect(parseSettingsText(json)).toEqual({ dailyNotes: false, editorFont: 'serif' })
    expect(resolveVaultSettings(json, null).editorFont).toBe('serif')
  })
})
