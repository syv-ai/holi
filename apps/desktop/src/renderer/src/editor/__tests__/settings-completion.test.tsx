/**
 * Suggestions in a settings file.
 *
 * **Driven through the source, not a mounted editor.** A `CompletionContext` is
 * the source's whole input, and a popup in jsdom would only tell us whether
 * jsdom lays out a tooltip.
 *
 * The one thing a real editor decides — that Enter and Tab reach the popup
 * rather than the indent commands — is keymap ORDER, and it is pinned at the
 * bottom by reading the facet rather than by pressing keys, which in jsdom
 * would assert jsdom's key handling instead of ours.
 */
import { expect, test } from 'vitest'
import { CompletionContext, acceptCompletion } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { SETTINGS_FILE, SETTINGS_LOCAL_FILE } from '@holi/shared'
import { settingsCompletion, settingsCompletionSource } from '../settings-completion'
import { plainTextExtensions } from '../extensions'

/** What the source offers with the cursor at the end of `doc`. */
function suggest(doc: string, target: 'committed' | 'local' = 'committed', explicit = false) {
  const state = EditorState.create({ doc })
  const context = new CompletionContext(state, doc.length, explicit)
  return settingsCompletionSource(target)(context)
}

const labels = (doc: string, target?: 'committed' | 'local', explicit?: boolean): string[] =>
  (suggest(doc, target, explicit)?.options ?? []).map((o) => o.label)

test('a boolean setting offers true and false', () => {
  expect(labels('dailyNotes: ')).toEqual(['true', 'false'])
})

test('an enum offers its values, with the pane’s own wording beside them', () => {
  const result = suggest('colorScheme: ', 'local')
  expect(result?.options.map((o) => o.label)).toEqual(['system', 'light', 'dark'])
  // The file and the settings tab should explain a choice in the same words.
  expect(result?.options.map((o) => o.detail)).toEqual(['Match my system', 'Light', 'Dark'])
})

test('a landing target is offered as it must be WRITTEN, not as it is shown', () => {
  // `{ kind: daily }`, because `landing: kind: daily` is a parse error and the
  // label "Today’s note" is not a value at all.
  expect(labels('landing: ')).toContain('{ kind: board }')
})

test('a number offers the sizes the pane offers — a suggestion is not a closed set', () => {
  // This is the difference from the dropdown it replaces. A menu would claim
  // these are the only legal values; the setting takes any positive number.
  const result = suggest('maxCommittedFileBytes: ')
  expect(result?.options.map((o) => o.label)).toContain('10485760')
  expect(result?.options.map((o) => o.detail)).toContain('10 MB')
})

test('a hooks flag offers true and false, though it is not a setting by name', () => {
  // The five switches live inside the `hooks` setting's type, not in
  // VAULT_SETTINGS, so a naive key lookup finds nothing for them.
  expect(labels('  archive-done: ')).toEqual(['true', 'false'])
})

test('completes a partly typed value, replacing only what was typed', () => {
  const result = suggest('editorFont: ser')
  expect(result?.from).toBe('editorFont: '.length)
  expect(result?.options.map((o) => o.label)).toContain('serif')
})

test('completes a key, and types the colon for you', () => {
  const result = suggest('edi')
  expect(result?.from).toBe(0)
  const option = result?.options.find((o) => o.label === 'editorFont')
  expect(option?.apply).toBe('editorFont: ')
})

test('offers only the keys that belong in this file', () => {
  // `colorScheme` is machine-local; suggesting it in the committed file would
  // be suggesting that a teammate's appearance choice gets shared.
  expect(labels('', 'committed', true)).not.toContain('colorScheme')
  expect(labels('', 'local', true)).toContain('colorScheme')
})

test('an empty line stays quiet unless you ask', () => {
  // Opening a file should not greet you with a list you did not summon.
  expect(suggest('', 'committed', false)).toBeNull()
  expect(suggest('', 'committed', true)).not.toBeNull()
})

test('a commented-out line still completes', () => {
  // Every unset setting is a comment, so this is the common case, not an edge.
  expect(labels('# editorFont: ')).toContain('serif')
})

test('nothing at all outside the settings files', () => {
  expect(settingsCompletion('notes/whatever.md')).toEqual([])
  expect(settingsCompletion(SETTINGS_FILE).length).toBeGreaterThan(0)
  expect(settingsCompletion(SETTINGS_LOCAL_FILE).length).toBeGreaterThan(0)
})

test('the completion keys outrank the indent keys', () => {
  // **Order, not presence.** Enter, Tab and the arrows are all bound further
  // down the plain stack, so a `completionKeymap` added after them produces a
  // popup that appears and cannot be used: Enter opens a line underneath it and
  // Tab indents. Read off the facet, because pressing keys in jsdom would be a
  // test of jsdom.
  const state = EditorState.create({ extensions: plainTextExtensions(SETTINGS_FILE) })
  const bindings = state.facet(keymap).flat()
  const first = (key: string): number => bindings.findIndex((b) => b.key === key)
  // `acceptCompletion` is the completion keymap's Enter; `indentWithTab` and
  // the defaults bring the other one.
  const completionEnter = bindings.findIndex((b) => b.key === 'Enter' && b.run === acceptCompletion)
  expect(completionEnter).toBeGreaterThanOrEqual(0)
  expect(first('Enter')).toBe(completionEnter)
  expect(bindings.findIndex((b) => b.key === 'Tab' && b.run === acceptCompletion)).toBeLessThan(
    bindings.findIndex((b) => b.key === 'Tab' && b.run !== acceptCompletion),
  )
})
