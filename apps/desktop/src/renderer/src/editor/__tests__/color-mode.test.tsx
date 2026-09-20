/**
 * The editor's colour mode, which CodeMirror cannot work out for itself.
 *
 * Asserted on the facet rather than on the rendered chrome: `EditorView.darkTheme`
 * is the input to every `&light` / `&dark` pair in CodeMirror's own base theme,
 * so it is the fact that matters, and jsdom does not resolve the cascade anyway.
 */
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, expect, it } from 'vitest'
import { baseEditorExtensions } from '../extensions'

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
  document.documentElement.removeAttribute('data-theme')
})

function mount(): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  view = new EditorView({
    state: EditorState.create({
      doc: 'note\n',
      extensions: baseEditorExtensions({
        docExists: () => true,
        taskByPath: () => null,
        readNote: async () => null,
        mentionData: () => ({ notes: [], tasks: [] }),
        nav: () => ({ openNote: () => {}, openExternal: () => {} }),
        notePath: 'note.md',
        askAgent: {
          targets: () => ({ sessions: [], initial: 'new' as const }),
          onAsk: () => Promise.resolve({ ok: true }),
        },
      }),
    }),
    parent,
  })
  return view
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

it('opens in the mode the root is stamped with', () => {
  document.documentElement.setAttribute('data-theme', 'light')
  expect(mount().state.facet(EditorView.darkTheme)).toBe(false)
})

// Dark-first, the same reading `index.css` makes: only an explicit stamp is light.
it('takes anything that is not light as dark', () => {
  expect(mount().state.facet(EditorView.darkTheme)).toBe(true)
})

// A view outlives a theme flip — panes are rebuilt per document, not per mode.
it('follows a flip while it is open', async () => {
  const v = mount()
  expect(v.state.facet(EditorView.darkTheme)).toBe(true)
  document.documentElement.setAttribute('data-theme', 'light')
  await settle()
  expect(v.state.facet(EditorView.darkTheme)).toBe(false)
  document.documentElement.setAttribute('data-theme', 'dark')
  await settle()
  expect(v.state.facet(EditorView.darkTheme)).toBe(true)
})
