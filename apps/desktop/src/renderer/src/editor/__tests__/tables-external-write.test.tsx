/**
 * A table in the full notes stack, with the file changing underneath it
 * (`docs/features/editor.md`, Tables). The table package normalises a table's
 * padding and the blank lines around it; Holi lets it do that only to a table
 * the user's own edit touched. Opening a note, and an external write landing
 * through `applyReload` (a sync pull, the agent), must leave the text exactly
 * as written: the autosave writes whatever the buffer holds.
 */
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, expect, it } from 'vitest'
import { applyReload } from '@/lib/apply-reload'
import { baseEditorExtensions } from '../extensions'

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

const TABLE = '| A | B |\n| --- | --- |\n| one | Bo |\n'
const NOTE = `# T\n\nShort intro.\n\n${TABLE}\nEnd.\n`
/** The same note as the package formats it. */
const PADDED = '# T\n\nShort intro.\n\n| A   | B  |\n| --- | -- |\n| one | Bo |\n\nEnd.\n'

/** Mounts the notes stack and records every document change after mount. */
function mount(doc: string): { view: EditorView; changes: string[] } {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const changes: string[] = []
  view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        baseEditorExtensions({
          docExists: () => true,
          taskByPath: () => null,
          readNote: async () => null,
          mentionData: () => ({ notes: [], tasks: [] }),
          nav: () => ({ openNote: () => {}, openExternal: () => {} }),
          notePath: 'note.md',
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) changes.push(u.state.doc.toString())
        }),
      ],
    }),
    parent,
  })
  ensureSyntaxTree(view.state, view.state.doc.length, 1000)
  return { view, changes }
}

/** Lets the package's listeners and the widget's effects run. */
const settle = () => new Promise((r) => setTimeout(r, 30))

it('opening a note leaves its table as written', async () => {
  const { view, changes } = mount(NOTE)
  // An update with no edit (the first measure, a click) is where the package
  // formatted a document whose history was still empty.
  view.dispatch({ selection: { anchor: 2 } })
  await settle()
  expect(changes).toEqual([])
  expect(view.state.doc.toString()).toBe(NOTE)
})

it('an external write that rewrites the table lands exactly as written', async () => {
  // The buffer's table differs from the incoming one from its first line, so
  // the minimal change starts in the intro and ends inside the table.
  const { view } = mount(PADDED)
  const incoming = NOTE.replace('Short intro.', 'A much longer intro line that shifts the table.')
  applyReload(view, incoming)
  await settle()
  expect(view.state.doc.toString()).toBe(incoming)
})

it('an external write is not reformatted afterwards', async () => {
  const { view, changes } = mount(NOTE)
  const incoming = NOTE.replace('Short intro.', 'Longer intro.').replace('Bo |', 'Bob |')
  applyReload(view, incoming)
  await settle()
  expect(changes).toEqual([incoming])
})

it('a table the user edits is still formatted', async () => {
  const { view } = mount(NOTE)
  const at = NOTE.indexOf('Bo |') + 2
  view.dispatch({ changes: { from: at, insert: 'b' }, userEvent: 'input.type' })
  await settle()
  expect(view.state.doc.toString()).toBe(
    '# T\n\nShort intro.\n\n| A   | B   |\n| --- | --- |\n| one | Bob |\n\nEnd.\n',
  )
})

it('an edit elsewhere leaves an untouched table as written', async () => {
  const { view } = mount(NOTE)
  view.dispatch({
    changes: { from: NOTE.indexOf('End.'), insert: 'The ' },
    userEvent: 'input.type',
  })
  await settle()
  expect(view.state.doc.toString()).toBe(NOTE.replace('End.', 'The End.'))
})
