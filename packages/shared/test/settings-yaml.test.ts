/**
 * A settings file that lists every setting, not just the answered ones.
 *
 * Two properties, and the second is the one that would rot silently. The file
 * has to carry the whole vocabulary — a setting you cannot see is a setting you
 * cannot use, which is what `editorFont` and `maxCommittedFileBytes` were for
 * as long as the file held only the birth ritual's four answers. And an unset
 * setting has to stay a COMMENT: the moment it is written as a value, D85's
 * argument is lost and this vault has frozen a default that can never be
 * raised for it again.
 */
import { describe, expect, it } from 'vitest'
import {
  VAULT_SETTING_DEFAULTS,
  VAULT_SETTINGS,
  parseSettingsText,
  resolveVaultSettings,
  seedSettings,
  seedSettingsText,
  writeSettingsText,
} from '../src/index'

const seeded = seedSettingsText(seedSettings('committed'), 'committed')
const seededLocal = seedSettingsText(seedSettings('local'), 'local')

describe('a seeded settings file', () => {
  it('names every setting filed under its layer, answered or not', () => {
    // Against the list, never a count. The gap this closes is exactly the two
    // settings the ritual does not ask about, which appeared in no file at all.
    for (const setting of VAULT_SETTINGS) {
      const text = setting.target === 'committed' ? seeded : seededLocal
      expect(text, setting.key).toContain(`${setting.key}:`)
      expect(text, setting.key).toContain(setting.label)
    }
  })

  it('says what a setting will accept, in the values a file uses', () => {
    // The options as VALUES, not as the labels the pane shows: this line is
    // read at the moment somebody is typing one.
    expect(seeded).toContain('One of: true, false')
    expect(seededLocal).toContain('One of: system (Match my system)')
    expect(seeded).toContain('{ kind: board }')
  })

  it('comments out a setting the ritual does not ask, so no default is frozen', () => {
    // D85: a number written into every vault at birth is a default that can
    // never be raised for the vaults that already have one. Visible in the
    // file, absent from the resolved values, is the whole point.
    expect(seeded).toContain('# maxCommittedFileBytes:')
    expect(seeded).not.toMatch(/^maxCommittedFileBytes:/m)
    expect(parseSettingsText(seeded).maxCommittedFileBytes).toBeUndefined()
    expect(parseSettingsText(seeded).editorFont).toBeUndefined()
  })

  it('resolves to exactly the defaults, like the file it replaces', () => {
    const resolved = resolveVaultSettings(seeded, seededLocal)
    expect(resolved.warnings).toEqual([])
    expect(resolved.dailyNotes).toBe(true)
    expect(resolved.landing).toEqual({ kind: 'daily' })
    // The commented ones fall through to the default rather than being absent.
    expect(resolved.editorFont).toBe(VAULT_SETTING_DEFAULTS.editorFont)
  })

  it('is block YAML, and a map beside its key is flow', () => {
    expect(seeded.startsWith('{')).toBe(false)
    expect(seeded).toMatch(/^hooks:\n {2}relink: true$/m)
    // `stringify` hands a one-entry map back as `kind: daily`, which becomes
    // `landing: kind: daily` after a key — a parse error, not a value.
    expect(seeded).toContain('landing: { kind: daily }')
  })
})

describe('writing to a settings file', () => {
  it('keeps the vocabulary, so a write cannot shrink the file', () => {
    const written = writeSettingsText(
      { ...seedSettings('committed'), dailyNotes: false },
      'committed',
    )
    expect(written).toContain('# editorFont:')
    expect(written).toContain('dailyNotes: false')
  })

  it('turns an answer back into a comment when it is unset', () => {
    const answered = writeSettingsText({ editorFont: 'serif' }, 'committed')
    expect(answered).toContain('editorFont: serif')
    expect(writeSettingsText({}, 'committed')).toContain('# editorFont:')
  })

  it('keeps a key no setting describes', () => {
    // `reminders` is the delivery watermark, written into the local file by
    // main. It is machine state, it has nothing to explain, and a writer that
    // dropped it would lose a vault's reminder history on the next click.
    const written = writeSettingsText({ reminders: { seen: 3 }, colorScheme: 'dark' }, 'local')
    expect(parseSettingsText(written).reminders).toEqual({ seen: 3 })
  })

  it('does NOT keep a comment somebody wrote by hand', () => {
    // Pinned as the cost, not as a feature. The writer generates the document
    // rather than merging into it, which is what keeps the vocabulary complete
    // when a setting is added later — and the price is that a personal note in
    // this file does not survive the next write. `writeThemeText` makes the
    // same trade and says why.
    const written = writeSettingsText(
      parseSettingsText('# my own note\ndailyNotes: true\n'),
      'committed',
    )
    expect(written).not.toContain('my own note')
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
