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

function mount(
  doc: string,
  openExternal: (url: string) => void,
  { openHistory, notePath = 'notes/plan.md' }: { openHistory?: () => void; notePath?: string } = {},
): EditorView {
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
        nav: () => ({ openNote: () => {}, openExternal, openHistory }),
        notePath,
        askAgent: {
          targets: () => ({ sessions: [], initial: 'new' as const }),
          onAsk: () => Promise.resolve({ ok: true }),
        },
      }),
    }),
    parent,
  })
  view.dispatch({
    effects: setFrontmatterCommit.of({
      date: '2026-09-24T09:30:00Z',
      author: 'ada-holm',
      revisions: 14,
    }),
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

it('ends the line with the version, after the name', () => {
  const v = mount(DOC, () => {})
  expect(v.dom.querySelector('.cm-fm-line')?.textContent).toBe(
    '▸6 chars · Last updated 24/09/26,ada-holm· v.14',
  )
  expect(v.dom.querySelector('.cm-fm-version')?.textContent).toBe('· v.14')
})

it('shows no link while the last commit is unknown', () => {
  const v = mount(DOC, () => {})
  v.dispatch({ effects: setFrontmatterCommit.of(null) })
  expect(v.dom.querySelector('.cm-fm-author')).toBeNull()
})

const press = (el: Element) =>
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

it('the version opens the history sidebar, and leaves the block closed', () => {
  const openHistory = vi.fn()
  const v = mount(DOC, () => {}, { openHistory })
  const link = v.dom.querySelector('.cm-fm-history')
  expect(link?.textContent).toBe('v.14')

  press(link!)
  expect(openHistory).toHaveBeenCalledOnce()
  expect(v.state.field(frontmatterExpandedField)).toBe(false)
})

it('the version is plain text on a task, whose history the sidebar does not show', () => {
  const v = mount('---\nstatus: todo\n---\n\n# Fix\n', () => {}, {
    openHistory: vi.fn(),
    notePath: 'projects/task.fix.md',
  })
  expect(v.dom.querySelector('.cm-fm-history')).toBeNull()
  expect(v.dom.querySelector('.cm-fm-version')?.textContent).toBe('· v.14')
})

it('the version is plain text where no sidebar can be opened', () => {
  const v = mount(DOC, () => {})
  expect(v.dom.querySelector('.cm-fm-history')).toBeNull()
})
