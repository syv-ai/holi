/**
 * Lists, checked where they actually have to land: in the rendered DOM.
 *
 * `livePreview`'s unit tests (`test/live-preview.test.ts`) prove the decorations
 * carry the right things. This proves they reach the DOM — a line decoration's
 * `attributes`, a widget's element, and the one thing no decoration can show on
 * its own, a checkbox writing back to the document when it is clicked. jsdom
 * does no layout, so the geometry the custom properties drive is hand-verified,
 * not asserted here.
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

function mount(doc: string, readOnly = false): EditorView {
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
        askAgent: () => {},
        readOnly,
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

// The caret sits at 0, so the list below the opening paragraph is inactive and
// renders; the line the caret is on shows its source, like every other mark.
it('renders a bullet in place of the marker', () => {
  const v = mount('para\n\n* top\n  - child\n')
  const bullets = [...v.contentDOM.querySelectorAll('.cm-list-bullet')].map((el) => el.textContent)
  expect(bullets).toEqual(['•', '◦'])
})

it('hides the indentation the author typed', () => {
  const v = mount('para\n\n- top\n  - child\n')
  // The two spaces before the child's marker are gone from the rendered line,
  // which is what lets the depth alone decide where it sits.
  const lines = [...v.contentDOM.querySelectorAll('.cm-line')].map((el) => el.textContent)
  expect(lines).toEqual(['para', '', '• top', '◦ child', ''])
})

it('leaves prose alone', () => {
  const v = mount('just a paragraph\n')
  expect(v.contentDOM.querySelectorAll('.cm-list')).toHaveLength(0)
})

it('leaves a bare marker alone until it has a space after it', () => {
  expect(mount('-\n').contentDOM.querySelectorAll('.cm-list')).toHaveLength(0)
  view?.destroy()
  view = null
  expect(mount('- \n').contentDOM.querySelectorAll('.cm-list')).toHaveLength(1)
})

function clickBox(v: EditorView): void {
  const box = v.contentDOM.querySelector('.cm-task-check')
  expect(box).not.toBeNull()
  box!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
}

it('writes the document when the checkbox is clicked, and back again', () => {
  const v = mount('- [ ] feed the cat\n')
  clickBox(v)
  expect(v.state.doc.toString()).toBe('- [x] feed the cat\n')
  clickBox(v)
  expect(v.state.doc.toString()).toBe('- [ ] feed the cat\n')
})

// A reconcile holds the file read-only (FR-19), and a control that wrote anyway
// would be the one way round a lock the rest of the editor honours.
it('refuses to toggle while the document is locked', () => {
  const v = mount('- [ ] feed the cat\n', true)
  clickBox(v)
  expect(v.state.doc.toString()).toBe('- [ ] feed the cat\n')
})
