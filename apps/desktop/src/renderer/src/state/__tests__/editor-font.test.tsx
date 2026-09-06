/**
 * The vault's editor font, as a custom property on `:root`.
 *
 * The name → stack resolution is `EDITOR_FONT_STACKS` in `@holi/shared`, tested
 * there. What only a DOM can show is that the property is actually written, that
 * it follows a vault switch, and that a vault which says nothing lands on mono
 * rather than on nothing at all — an unset var would take the theme's fallback,
 * which is the same stack, so a broken hook would look identical in the app and
 * only this test would catch it.
 */
import { Provider, createStore } from 'jotai'
import { expect, test } from 'vitest'
import { EDITOR_FONT_STACKS, type ResolvedVaultSettings } from '@holi/shared'
import { render } from '@/test/render'
import { EDITOR_FONT_VAR, useEditorFont } from '../editor-font'
import { vaultSettingsAtom } from '../settings'

const settings = (editorFont: ResolvedVaultSettings['editorFont']): ResolvedVaultSettings => ({
  landing: { kind: 'daily' },
  dailyNotes: true,
  colorScheme: 'system',
  editorFont,
  hooks: { relink: true, 'archive-done': false, 'normalize-md': true },
  maxCommittedFileBytes: 10 * 1024 * 1024,
  warnings: [],
})

function Probe(): null {
  useEditorFont()
  return null
}

function mount(font: ResolvedVaultSettings['editorFont'] | null) {
  const store = createStore()
  if (font !== null) store.set(vaultSettingsAtom, { remote: 'o/r', settings: settings(font) })
  return render(
    <Provider store={store}>
      <Probe />
    </Provider>,
  )
}

const stamped = () => document.documentElement.style.getPropertyValue(EDITOR_FONT_VAR)

test('a vault asking for serif gets the serif stack', () => {
  mount('serif')
  expect(stamped()).toBe(EDITOR_FONT_STACKS.serif)
})

test('a vault asking for sans gets the sans stack', () => {
  mount('sans')
  expect(stamped()).toBe(EDITOR_FONT_STACKS.sans)
})

test('no vault open is mono, not unset', () => {
  mount(null)
  expect(stamped()).toBe(EDITOR_FONT_STACKS.mono)
})

test('a vault switch re-stamps it', () => {
  const store = createStore()
  store.set(vaultSettingsAtom, { remote: 'o/prose', settings: settings('serif') })
  const view = render(
    <Provider store={store}>
      <Probe />
    </Provider>,
  )
  expect(stamped()).toBe(EDITOR_FONT_STACKS.serif)

  store.set(vaultSettingsAtom, { remote: 'o/code', settings: settings('mono') })
  view.rerender(
    <Provider store={store}>
      <Probe />
    </Provider>,
  )
  expect(stamped()).toBe(EDITOR_FONT_STACKS.mono)
})
