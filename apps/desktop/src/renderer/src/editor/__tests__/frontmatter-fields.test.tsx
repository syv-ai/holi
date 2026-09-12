/**
 * Which of its three faces the frontmatter block shows, and how the rows reach
 * React at all.
 *
 * The widget itself is plain DOM, like every other widget in this editor and
 * like the table widget it is modelled on. What it draws for a file with a
 * schema is an empty container published to `frontmatter-portals`, which the
 * app's single React root fills. These tests are about that choice and that
 * hand-off; what the rows then look like is `FrontmatterFields`' own test.
 */
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, expect, it } from 'vitest'
import { baseEditorExtensions } from '../extensions'
import { frontmatterPortals } from '../frontmatter-portals'
import { bodyStart, toggleFrontmatter } from '../frontmatter'

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

function mount(doc: string, notePath: string): EditorView {
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
        notePath,
        askAgent: () => {},
      }),
    }),
    parent,
  })
  return view
}

const TASK = 'projects/task.fix-the-tap.md'

it('a task file opens with its frontmatter already showing', () => {
  // `frontmatterStartsRevealed`: FR-2 hides a note's frontmatter because it is
  // metadata over prose. A task's frontmatter is half of what the file IS.
  const v = mount('---\nstatus: todo\n---\n\n# Fix the tap\n', TASK)
  expect(v.dom.querySelector('[data-frontmatter]')?.getAttribute('data-frontmatter')).toBe('fields')
})

it('publishes a container for React, carrying the path and the YAML', () => {
  mount('---\nstatus: doing\ndue: 2026-08-25\n---\n\n# Fix the tap\n', TASK)

  const portal = frontmatterPortals().at(-1)
  expect(portal?.path).toBe(TASK)
  expect(portal?.yaml).toBe('status: doing\ndue: 2026-08-25\n')
  expect(portal?.el.isConnected).toBe(true)
})

it('a write from the fields lands in the document', () => {
  const v = mount('---\nstatus: todo\n---\n\n# Fix the tap\n', TASK)

  frontmatterPortals().at(-1)!.write('status: doing\n')

  expect(v.state.doc.toString()).toBe('---\nstatus: doing\n---\n\n# Fix the tap\n')
})

it('the container goes when the editor does, so nothing is left to draw into', () => {
  mount('---\nstatus: todo\n---\n\n# Fix the tap\n', TASK)
  const before = frontmatterPortals().length

  view!.destroy()
  view = null

  expect(frontmatterPortals()).toHaveLength(before - 1)
})

it('the agent surface still gets the YAML editor, not rows', () => {
  // Its frontmatter is a typed interface with a schema of its own, and this app
  // inventing a shape for it would be inventing somebody else's contract.
  const v = mount('---\nname: demo\n---\n\n# Body\n', '.claude/skills/demo/SKILL.md')
  expect(v.dom.querySelector('[data-frontmatter]')?.getAttribute('data-frontmatter')).toBe(
    'expanded',
  )
  expect(v.dom.querySelector('.cm-fm-fields')).toBeNull()
})

it('frontmatter that will not parse falls back to the YAML editor', () => {
  // The fallback is the same surface, which is the point: a document with no
  // rows to draw has one honest place to be fixed, and it is the text.
  const v = mount('---\nstatus: "unterminated\n---\n\n# Fix the tap\n', TASK)
  expect(v.dom.querySelector('.cm-fm-fields')).toBeNull()
})

it('a task block has no chevron, because it has no collapsed state', () => {
  // The pill answers "what is in this file?" with a body char count, which for
  // a task summarises the half that is not the point. A control whose only
  // setting makes the view worse is not worth offering.
  const v = mount('---\nstatus: todo\n---\n\n# Fix the tap\n', TASK)
  expect(v.dom.querySelector('[data-frontmatter-header]')).toBeNull()
})

it('a task block cannot be collapsed, whatever dispatches the toggle', () => {
  // Enforced in the state field, not by hiding the button: the rule is about
  // the file, and a keybinding or a stray effect must not get round it.
  const v = mount('---\nstatus: todo\n---\n\n# Fix the tap\n', TASK)
  v.dispatch({ effects: toggleFrontmatter.of(false) })
  expect(v.dom.querySelector('[data-frontmatter]')?.getAttribute('data-frontmatter')).toBe('fields')
})

it('a note keeps its chevron and still collapses', () => {
  const v = mount('---\ncreated: 2026-09-12\n---\n\nprose\n', 'notes/meeting.md')
  v.dispatch({ effects: toggleFrontmatter.of(true) })
  expect(v.dom.querySelector('[data-frontmatter-header]')).not.toBeNull()
  v.dispatch({ effects: toggleFrontmatter.of(false) })
  expect(v.dom.querySelector('[data-frontmatter]')?.getAttribute('data-frontmatter')).toBe(
    'collapsed',
  )
})

it('a bare caret cannot rest in the block — it lands on the first body line', () => {
  const doc = '---\nstatus: todo\n---\n\n# Fix the tap\n'
  const v = mount(doc, TASK)
  for (const at of [0, 5, 18, 21]) {
    v.dispatch({ selection: EditorSelection.cursor(at) })
    expect(v.state.selection.main.head).toBe(bodyStart(doc))
  }
})

it('a selection whose head is in the block hides the caret, not the selection', () => {
  // A drag up into the block, or a select-all that ends there. The region is
  // atomic, so a caret claiming an insertion point inside it is a lie — and it
  // renders as tall as the whole block. The range itself is untouched.
  const doc = '---\nstatus: todo\n---\n\n# Fix the tap\n'
  const v = mount(doc, TASK)

  v.dispatch({ selection: EditorSelection.range(doc.length, 2) })
  expect(v.dom.classList.contains('cm-fm-caret-hidden')).toBe(true)
  expect(v.state.selection.main.from).toBe(2)
  expect(v.state.selection.main.to).toBe(doc.length)

  v.dispatch({ selection: EditorSelection.range(bodyStart(doc), doc.length) })
  expect(v.dom.classList.contains('cm-fm-caret-hidden')).toBe(false)
})
