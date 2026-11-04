/**
 * The colour swatch, restyled.
 *
 * `@replit/codemirror-css-color-picker` paints `outline: 1px solid #eee` on its
 * wrapper, which is a bright ring on a near-black editor. The fix is precedence
 * — `EditorView.theme` over the extension's `baseTheme` — and precedence is
 * exactly the kind of thing that looks right in the source and is wrong on
 * screen, so it is pinned here rather than eyeballed.
 */
import { render } from '@/test/render'
import { useEffect, useRef } from 'react'
import { expect, test } from 'vitest'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { THEME_FILE } from '@holi/shared'
import { plainTextExtensions } from '../extensions'

function mount(doc: string): EditorView {
  let view: EditorView | null = null
  function Host(): React.JSX.Element {
    const host = useRef<HTMLDivElement | null>(null)
    useEffect(() => {
      const state = EditorState.create({ doc, extensions: plainTextExtensions(THEME_FILE) })
      // The color-picker plugin discovers decorations in its constructor. Finish
      // CodeMirror's incremental parse first so this assertion tests the actual
      // CSS-color widget, not whether a scheduled parse happened to run in time.
      if (!ensureSyntaxTree(state, state.doc.length, 1000)) {
        throw new Error('CodeMirror did not finish parsing the editor document')
      }
      view = new EditorView({ state, parent: host.current! })
      return () => view?.destroy()
    }, [])
    return <div ref={host} />
  }
  render(<Host />)
  return view!
}

test('a hex in a CSS file gets the published swatch', async () => {
  const view = mount("[data-theme='dark'] {\n  --primary: #8b5cf6;\n}\n")
  expect(view.dom.querySelector('.cm-css-color-picker-wrapper')).not.toBeNull()
  view.destroy()
})

test('the swatch carries no outline of its own', () => {
  // **The emitted RULE, not a computed style.** jsdom does not resolve the
  // stylesheet CodeMirror injects at runtime, so `getComputedStyle` reports ''
  // whatever either extension says — a test on that would pass with the
  // override deleted. What can be checked here is that our rule is emitted at
  // all; that `EditorView.theme` outranks the extension's `baseTheme` is
  // CodeMirror's documented contract, and is what the override relies on.
  const view = mount("[data-theme='dark'] {\n  --primary: #8b5cf6;\n}\n")
  const rules = [...document.styleSheets]
    .flatMap((sheet) => {
      try {
        return [...sheet.cssRules].map((r) => r.cssText)
      } catch {
        return []
      }
    })
    .filter((text) => text.includes('cm-css-color-picker-wrapper'))

  expect(rules.some((r) => r.includes('outline: none'))).toBe(true)
  view.destroy()
})
