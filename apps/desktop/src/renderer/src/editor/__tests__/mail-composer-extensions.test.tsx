/**
 * The composer's editor stack (D71).
 *
 * The point of a third stack is what it does *not* carry. `baseEditorExtensions`
 * decorates `[[wiki links]]` into chips and completes `@` against vault notes —
 * both meaningless to a recipient, and the second would paste vault paths into
 * an email. These tests assert the absences, because an absence is exactly what
 * a later "let's just reuse the notes stack" refactor would silently undo.
 */
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { mailComposerExtensions } from '../extensions'

let view: EditorView | null = null

function mount(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  view = new EditorView({
    state: EditorState.create({ doc, extensions: mailComposerExtensions() }),
    parent,
  })
  return view
}

afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

describe('mailComposerExtensions', () => {
  it('leaves a [[wiki link]] as literal text, with no chip', () => {
    // The assertion the whole stack exists for. In the notes editor this
    // becomes a `.cm-wikilink` widget pointing at a vault path.
    const editor = mount('see [[projects/q2.md]] for the numbers')

    expect(editor.dom.querySelector('.cm-wikilink')).toBeNull()
    expect(editor.dom.textContent).toContain('[[projects/q2.md]]')
  })

  it('does not hide frontmatter — a mail beginning with --- is just a rule', () => {
    const editor = mount('---\ntitle: not frontmatter\n---\n\nHello.')

    expect(editor.dom.querySelector('.cm-frontmatter')).toBeNull()
    expect(editor.dom.textContent).toContain('title: not frontmatter')
  })

  it('holds the document it was given', () => {
    expect(mount('Hello.').state.doc.toString()).toBe('Hello.')
  })

  it('wraps long lines rather than scrolling sideways', () => {
    // Mail is prose in a narrow pane; horizontal scrolling would be a bug the
    // user meets on the first long sentence.
    // Asserted through the class CodeMirror actually puts on the content —
    // `EditorView.lineWrapping` is an Extension, not a readable facet.
    const editor = mount('x')

    expect(editor.dom.querySelector('.cm-lineWrapping')).not.toBeNull()
  })

  it('takes no vault dependencies at all', () => {
    // If this ever needs an argument, the composer has been given a way to
    // reach the vault and the separation above has been lost.
    expect(mailComposerExtensions).toHaveLength(0)
  })
})
