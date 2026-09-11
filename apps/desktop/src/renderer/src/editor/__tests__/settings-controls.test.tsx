/**
 * Menus over the settings files Holi actually writes.
 *
 * **The fixtures come from the production writers, not from hand-typed YAML.**
 * This module matches lines by shape, so a test against a document written here
 * would agree with itself while the real file went undecorated — which is
 * exactly how a lowercase-only key pattern passed review and silently skipped
 * `dailyNotes`, `colorScheme`, `editorFont` and `maxCommittedFileBytes`.
 *
 * **Assertions go through `controlsIn`, not the DOM.** CodeMirror only builds
 * DOM for the lines it is rendering, and jsdom gives an editor no height, so
 * counting widgets on screen measures the viewport rather than this module.
 *
 * Colours are not tested here — a hex swatch is `color-swatches.ts`, and it has
 * nothing to do with the settings schema.
 */
import { expect, test } from 'vitest'
import { SETTINGS_FILE, SETTINGS_LOCAL_FILE, seedSettings, seedSettingsText } from '@holi/shared'
import { controlsIn } from '../settings-controls'

const appText = seedSettingsText(seedSettings('committed'), 'committed')
const localText = seedSettingsText(seedSettings('local'), 'local')

test('a camelCase setting gets its menu', () => {
  // The regression that motivated the test: `[a-z]`-only keys matched `landing`
  // and `hooks` and silently skipped every camelCase setting.
  const keys = controlsIn(SETTINGS_FILE, appText).map((c) => c.key)
  expect(keys).toContain('dailyNotes')
  expect(controlsIn(SETTINGS_LOCAL_FILE, localText).map((c) => c.key)).toContain('colorScheme')
})

test('a number gets no menu — the options are what the pane offers, not the range', () => {
  // `maxCommittedFileBytes` takes any positive number; a menu would claim
  // otherwise, which is the same reason its file line says so in words.
  expect(controlsIn(SETTINGS_FILE, appText).map((c) => c.key)).not.toContain(
    'maxCommittedFileBytes',
  )
})

test('an ordinary note is untouched — a key called primary is not a token there', () => {
  expect(controlsIn('notes/palette.md', 'primary: "#8b5cf6"\ncolorScheme: dark\n')).toEqual([])
})
