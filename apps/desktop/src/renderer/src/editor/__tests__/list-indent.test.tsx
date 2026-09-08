/**
 * The list indent, checked where it actually has to land: on the line element.
 *
 * `livePreview`'s unit tests (`test/live-preview.test.ts`) prove the numbers the
 * decoration carries. This proves a line decoration's `attributes` reach the
 * rendered `.cm-line` at all, which is the half of the mechanism a wrong API
 * call would fail silently. jsdom does no layout, so the geometry those custom
 * properties drive is hand-verified, not asserted here.
 */
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, expect, it } from 'vitest'
import { baseEditorExtensions } from '../extensions'

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
})

function mount(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: baseEditorExtensions({
        docExists: () => true,
        taskByPath: () => null,
        readNote: async () => null,
        mentionData: () => ({ notes: [], tasks: [] }),
        nav: () => ({ openNote: () => {}, openExternal: () => {} }),
        notePath: 'note.md',
      }),
    }),
    parent,
  })
  return view
}

it('stamps each list line with its own depth', () => {
  const v = mount('prose\n\n- top\n  - child\n\n10. ten\n')
  const styles = [...v.contentDOM.querySelectorAll('.cm-list')].map((el) =>
    el.getAttribute('style'),
  )
  expect(styles).toEqual([
    // Normalized by the DOM on the way in, which is itself the proof that this
    // lands as a real custom property rather than as an unparsed string.
    '--list-depth: 1;',
    '--list-depth: 2;',
    '--list-depth: 1;',
  ])
})

it('hides the indentation the author typed', () => {
  const v = mount('- top\n  - child\n')
  // The two spaces before the child's marker are gone from the rendered line,
  // which is what lets the depth alone decide where it sits.
  const lines = [...v.contentDOM.querySelectorAll('.cm-line')].map((el) => el.textContent)
  expect(lines).toEqual(['- top', '- child', ''])
})

it('leaves prose alone', () => {
  const v = mount('just a paragraph\n')
  expect(v.contentDOM.querySelectorAll('.cm-list')).toHaveLength(0)
})
