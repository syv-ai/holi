/**
 * The frontmatter summary's author is a link to their GitHub profile.
 *
 * The name is the git author name, used as the GitHub username. Pressing it
 * goes out through the editor's own `openExternal` seam (`linkNavFacet`), and
 * nothing else: it sits beside the collapse button, so it must not also open
 * the block.
 */
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, expect, it, vi } from 'vitest'
import { baseEditorExtensions } from '../extensions'
import { frontmatterExpandedField, setFrontmatterCommit } from '../frontmatter'

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

function mount(doc: string, openExternal: (url: string) => void): EditorView {
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
        nav: () => ({ openNote: () => {}, openExternal }),
        notePath: 'notes/plan.md',
        askAgent: {
          targets: () => ({ sessions: [], initial: 'new' as const }),
          onAsk: () => Promise.resolve({ ok: true }),
        },
      }),
    }),
    parent,
  })
  view.dispatch({
    effects: setFrontmatterCommit.of({ date: '2026-09-24T09:30:00Z', author: 'ada-holm' }),
  })
  return view
}

const DOC = '---\ncreated: 2026-09-24\n---\n\n# Plan\n'

it('shows the author beside the collapse button, not inside it', () => {
  const v = mount(DOC, () => {})
  const link = v.dom.querySelector<HTMLAnchorElement>('.cm-fm-author')
  expect(link?.textContent).toBe('ada-holm')
  expect(link?.href).toBe('https://github.com/ada-holm')
  expect(link?.closest('button')).toBeNull()
})

it('opens the profile through the editor seam, and leaves the block closed', () => {
  const openExternal = vi.fn()
  const v = mount(DOC, openExternal)
  v.dom
    .querySelector('.cm-fm-author')!
    .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

  expect(openExternal).toHaveBeenCalledWith('https://github.com/ada-holm')
  expect(v.state.field(frontmatterExpandedField)).toBe(false)
})

it('shows no link while the last commit is unknown', () => {
  const v = mount(DOC, () => {})
  v.dispatch({ effects: setFrontmatterCommit.of(null) })
  expect(v.dom.querySelector('.cm-fm-author')).toBeNull()
})
