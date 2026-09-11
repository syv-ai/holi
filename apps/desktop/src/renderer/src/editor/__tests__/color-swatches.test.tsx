/**
 * A swatch beside a hex, in whatever file it appears in.
 *
 * The two things worth pinning are the two that would fail silently: which
 * strings count as a colour (a swatch beside a git SHA is worse than no swatch
 * at all), and that picking edits the document rather than only the widget.
 */
import { render } from '@/test/render'
import { useEffect, useRef } from 'react'
import { expect, test } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { THEME_FILE } from '@holi/shared'
import { plainTextExtensions } from '../extensions'
import { baseEditorExtensions } from '../extensions'

/** A mounted editor. Docs are kept short so CodeMirror renders all of them —
 *  it only builds DOM for lines in the viewport, and jsdom measures none. */
function mount(doc: string, path = THEME_FILE): EditorView {
  let view: EditorView | null = null
  function Host(): React.JSX.Element {
    const host = useRef<HTMLDivElement | null>(null)
    useEffect(() => {
      view = new EditorView({
        state: EditorState.create({ doc, extensions: plainTextExtensions(path) }),
        parent: host.current!,
      })
      return () => view?.destroy()
    }, [])
    return <div ref={host} />
  }
  render(<Host />)
  return view!
}

const swatches = (view: EditorView): string[] =>
  [...view.dom.querySelectorAll('.cm-hex-swatch')].map((el) => (el as HTMLElement).style.background)

test('a hex gets a swatch painted with the value itself', () => {
  const view = mount('dark:\n  brand: "#8b5cf6"\n')
  expect(swatches(view)).toEqual(['rgb(139, 92, 246)'])
  view.destroy()
})

test('three, four, six and eight digits are colours; five and seven are not', () => {
  // `{3,8}` would paint a square beside a git SHA fragment and offer to edit it.
  const view = mount(['a: "#abc"', 'b: "#abcd"', 'c: "#aabbcc"', 'd: "#aabbccdd"'].join('\n'))
  expect(swatches(view)).toHaveLength(4)
  view.destroy()

  const bad = mount(['a: "#abcde"', 'b: "#abcdefa"'].join('\n'))
  expect(swatches(bad)).toHaveLength(0)
  bad.destroy()
})

test('a YAML comment is not a colour', () => {
  // The leading `#` is also YAML's comment marker, which is why the generated
  // settings files are full of `# background:` lines.
  const view = mount('# ── Surfaces: the page\n# background:\n')
  expect(swatches(view)).toHaveLength(0)
  view.destroy()
})

test('picking writes the new value over the old one', () => {
  const view = mount('dark:\n  brand: "#8b5cf6"\n')
  const input = view.dom.querySelector('.cm-hex-swatch input') as HTMLInputElement
  input.value = '#ff0000'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  expect(view.state.doc.toString()).toContain('brand: "#ff0000"')
  view.destroy()
})

test('a shorthand hex keeps its own form until you pick a new one', () => {
  // The native input speaks `#rrggbb` only, so `#abc` has to be widened for its
  // starting position — but widening must not rewrite the document by itself.
  const view = mount('a: "#abc"\n')
  const input = view.dom.querySelector('.cm-hex-swatch input') as HTMLInputElement
  expect(input.value).toBe('#aabbcc')
  expect(view.state.doc.toString()).toBe('a: "#abc"\n')
  view.destroy()
})

test('a note gets swatches too — it is an editor feature, not a settings one', () => {
  // The markdown stack, not the plain one. A swatch that only appeared in
  // `.yaml` would be a settings feature wearing an editor's clothes.
  let view: EditorView | null = null
  function Host(): React.JSX.Element {
    const host = useRef<HTMLDivElement | null>(null)
    useEffect(() => {
      view = new EditorView({
        state: EditorState.create({
          doc: 'The brand is #8b5cf6 this quarter.\n',
          extensions: baseEditorExtensions({
            docExists: () => false,
            taskByPath: () => null,
            readNote: () => Promise.resolve(null),
            mentionData: () => ({ notes: [], tasks: [] }),
            nav: () => ({ openNote: () => {}, openTask: () => {}, openExternal: () => {} }),
            askAgent: () => {},
            notePath: 'notes/brand.md',
          }),
        }),
        parent: host.current!,
      })
      return () => view?.destroy()
    }, [])
    return <div ref={host} />
  }
  render(<Host />)
  expect(swatches(view!)).toEqual(['rgb(139, 92, 246)'])
  view!.destroy()
})
