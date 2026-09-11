/**
 * Swatches and menus over the settings files Holi actually writes.
 *
 * **The fixtures come from the production writers, not from hand-typed YAML.**
 * This module matches lines by shape, so a test against a document written here
 * would agree with itself while the real file went undecorated — which is
 * exactly how a lowercase-only key pattern passed review and silently skipped
 * `dailyNotes`, `colorScheme`, `editorFont` and `maxCommittedFileBytes`.
 *
 * **Most assertions go through `controlsIn`, not the DOM.** CodeMirror only
 * builds DOM for the lines it is rendering, and jsdom gives an editor no
 * height, so counting swatches on screen measures the viewport rather than this
 * module. The one DOM test below is the one thing only a real editor can show:
 * that picking a colour edits the document.
 */
import { render } from '@/test/render'
import { useEffect, useRef } from 'react'
import { expect, test } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  THEME_FILE,
  THEME_COLOR_TOKENS,
  applyThemePatch,
  seedSettings,
  seedSettingsText,
} from '@holi/shared'
import { controlsIn } from '../settings-controls'
import { plainTextExtensions } from '../extensions'

const themeText = (patch = {}) => applyThemePatch(null, patch)
const appText = seedSettingsText(seedSettings('committed'), 'committed')
const localText = seedSettingsText(seedSettings('local'), 'local')

test('every colour token gets a swatch, in both palettes', () => {
  const controls = controlsIn(THEME_FILE, themeText())
  const colors = controls.filter((c) => c.kind === 'color')
  // Both blocks, so each token appears twice. Against the list, never a count.
  for (const slug of THEME_COLOR_TOKENS) {
    expect(
      colors.filter((c) => c.key === slug),
      slug,
    ).toHaveLength(2)
  }
})

test('radius and the shadows get no swatch — they are not colours', () => {
  const keys = controlsIn(THEME_FILE, themeText()).map((c) => c.key)
  expect(keys).not.toContain('radius')
  expect(keys).not.toContain('shadow-popover')
  expect(keys).not.toContain('shadow-dialog')
})

test('an unset token still offers a swatch — it is Holi’s colour, not no colour', () => {
  const controls = controlsIn(THEME_FILE, themeText({ dark: { primary: '#8b5cf6' } }))
  const primaries = controls.filter((c) => c.key === 'primary')
  expect(primaries.map((c) => c.commented).sort()).toEqual([false, true])
})

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

test('picking a colour on a commented line sets it, quoted, and uncomments it', () => {
  // Short enough that CodeMirror renders all of it, so the widget is in the DOM.
  const doc = ['$schema: holi-theme/v1', 'dark:', '  # brand:'].join('\n')
  let view: EditorView | null = null
  function Host(): React.JSX.Element {
    const host = useRef<HTMLDivElement | null>(null)
    useEffect(() => {
      view = new EditorView({
        state: EditorState.create({ doc, extensions: plainTextExtensions(THEME_FILE) }),
        parent: host.current!,
      })
      return () => view?.destroy()
    }, [])
    return <div ref={host} />
  }
  render(<Host />)

  const input = view!.dom.querySelector('.cm-settings-swatch input') as HTMLInputElement
  expect(input).not.toBeNull()
  input.value = '#ff0000'
  input.dispatchEvent(new Event('input', { bubbles: true }))

  const after = view!.state.doc.toString()
  // Quoted, because a bare `#ff0000` is a YAML comment and the value would vanish.
  expect(after).toContain('  brand: "#ff0000"')
  expect(after).not.toContain('# brand:')
  view!.destroy()
})
