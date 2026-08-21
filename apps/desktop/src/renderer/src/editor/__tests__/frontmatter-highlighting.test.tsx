/**
 * The revealed frontmatter is a YAML editor, and it should look like one
 * (`notes-editor.md` §Frontmatter reveal control).
 *
 * It is a *nested* CodeMirror inside the widget, which is why it missed out:
 * the outer stack's language never reached it, so the block that carries a
 * task's whole record rendered as undifferentiated grey.
 */
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, expect, it } from 'vitest'
import { baseEditorExtensions } from '../extensions'

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

/** A `.claude/` path starts revealed (`frontmatterStartsRevealed`), which is
 *  what puts the nested editor on screen without a click. */
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
        notePath: '.claude/skills/demo/SKILL.md',
      }),
    }),
    parent,
  })
  return view
}

it('colours the YAML in the revealed frontmatter', () => {
  const v = mount('---\nname: demo\ndescription: a seeded skill\n---\n\n# Body\n')
  const tokens = [...v.dom.querySelectorAll('.cm-fm-body .cm-content span')]
    .map((el) => el.textContent ?? '')
    .filter((t) => t.trim() !== '')
  expect(tokens).toContain('name')
})
