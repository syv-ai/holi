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
import { EditorView } from '@codemirror/view'
import { THEME_FILE } from '@holi/shared'
import { plainTextExtensions } from '../extensions'

function mount(doc: string): EditorView {
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
  return view!
}

test('a hex in a CSS file gets the published swatch', () => {
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
