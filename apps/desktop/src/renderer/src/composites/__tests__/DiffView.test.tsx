/**
 * `DiffView`, in its two modes (D88, toward #4).
 *
 * It has always been a read-only view of history. The turn review needs the same
 * diff to be *resolvable* — reject a hunk the agent wrote and the file goes back
 * — so `onResolve` turns on `@codemirror/merge`'s own accept/reject controls and
 * makes the document editable.
 *
 * The read-only mode is asserted here rather than assumed, because the history
 * panel has depended on it since it was written and nothing else guards it.
 */
import { EditorView } from '@codemirror/view'
import { render } from '@/test/render'
import { afterEach, expect, test, vi } from 'vitest'
import { DiffView } from '../DiffView'

const BEFORE = 'one\ntwo\nthree\n'
const AFTER = 'one\nCHANGED\nthree\n'

/**
 * `@codemirror/merge` renders its per-hunk controls as buttons named `accept`
 * and `reject` inside the chunk's own header. Their absence is the whole of
 * read-only mode.
 */
const mergeButtons = (root: HTMLElement) =>
  [...root.querySelectorAll('button')].map((b) => b.getAttribute('name') ?? '')

/**
 * The package binds these to `onmousedown`, not to `click` — it has to act
 * before the editor takes focus and moves the selection. A `.click()` does
 * nothing at all, which is a quiet way for this test to pass while the button
 * is dead.
 */
const press = (button: HTMLButtonElement) =>
  button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

test('is read-only and shows no merge controls without onResolve', () => {
  const { container } = render(<DiffView before={BEFORE} after={AFTER} />)
  const content = container.querySelector('.cm-content')
  expect(content).not.toBeNull()
  expect(content!.getAttribute('contenteditable')).not.toBe('true')
  expect(mergeButtons(container)).toEqual([])
})

test('offers merge controls when a resolver is given', () => {
  const { container } = render(<DiffView before={BEFORE} after={AFTER} onResolve={() => {}} />)
  expect(container.querySelector('.cm-content')!.getAttribute('contenteditable')).toBe('true')
  expect(mergeButtons(container)).toContain('reject')
  expect(mergeButtons(container)).toContain('accept')
})

test('rejecting the only chunk hands back the original text', () => {
  // The point of the whole panel: a hunk the agent wrote, taken back. With one
  // chunk, rejecting it means the document IS the before-content.
  const onResolve = vi.fn()
  const { container } = render(<DiffView before={BEFORE} after={AFTER} onResolve={onResolve} />)
  const reject = container.querySelector<HTMLButtonElement>('button[name="reject"]')
  expect(reject, 'no reject control rendered').not.toBeNull()
  press(reject!)
  expect(onResolve).toHaveBeenCalled()
  expect(onResolve.mock.calls.at(-1)![0]).toBe(BEFORE)
})

test('does not rebuild the view when the resolver identity changes', () => {
  // `onResolve` is a fresh closure on every render of the panel above. Rebuilding
  // the EditorView on each one would destroy the merge state mid-resolution, so
  // the callback is held in a ref and kept out of the effect's dependencies.
  const { container, rerender } = render(
    <DiffView before={BEFORE} after={AFTER} onResolve={() => {}} />,
  )
  const first = container.querySelector('.cm-editor')
  rerender(<DiffView before={BEFORE} after={AFTER} onResolve={() => {}} />)
  expect(container.querySelector('.cm-editor')).toBe(first)
})

/**
 * The colour mode. This view used to declare `{ dark: true }` unconditionally,
 * which was true of the app until light mode shipped (D85) and after that put a
 * black `#0a0a0a` band across every diff in a light vault.
 *
 * Asserted on `EditorView.darkTheme` for the reason `editor/color-mode.test`
 * gives: it is the input to every `&light`/`&dark` pair in CodeMirror's and
 * `@codemirror/merge`'s base themes, and jsdom does not resolve the cascade.
 */
afterEach(() => document.documentElement.removeAttribute('data-theme'))

const viewIn = (root: HTMLElement): EditorView => {
  const view = EditorView.findFromDOM(root.querySelector<HTMLElement>('.cm-editor')!)
  expect(view, 'no EditorView mounted').not.toBeNull()
  return view!
}

test('takes its colour mode from the root stamp, not from a hardcoded flag', () => {
  document.documentElement.setAttribute('data-theme', 'light')
  const { container } = render(<DiffView before={BEFORE} after={AFTER} />)
  expect(viewIn(container).state.facet(EditorView.darkTheme)).toBe(false)
})

// Dark-first, the same reading `index.css` makes: only an explicit stamp is light.
test('takes anything that is not light as dark', () => {
  const { container } = render(<DiffView before={BEFORE} after={AFTER} />)
  expect(viewIn(container).state.facet(EditorView.darkTheme)).toBe(true)
})

test('follows a theme flip while a diff is open', async () => {
  const { container } = render(<DiffView before={BEFORE} after={AFTER} />)
  const view = viewIn(container)
  expect(view.state.facet(EditorView.darkTheme)).toBe(true)
  document.documentElement.setAttribute('data-theme', 'light')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(view.state.facet(EditorView.darkTheme)).toBe(false)
})
