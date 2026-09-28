/**
 * The popup's rows. A CodeMirror option is built with `document.createElement`,
 * so these renderers are plain DOM and testable without an editor.
 */
import { expect, test } from 'vitest'
import { holiIcon, holiMeta, holiEnterHint, type HoliCompletion } from '../completion'

// Typed, not inferred: `emoji` and `meta` are ours, and an object literal
// widened to CodeMirror's `Completion` would be rejected for carrying them.
const row = (c: HoliCompletion): HoliCompletion => c

test('a note with a vault emoji draws the emoji, not a glyph', () => {
  const node = holiIcon(row({ label: 'daily/2026-09-13', type: 'holi-note', emoji: '📓' }))
  expect((node as HTMLElement).textContent).toBe('📓')
})

test('a row from a source we do not author gets no icon of ours', () => {
  expect(holiIcon(row({ label: '2x2', type: 'table' }))).toBeNull()
})

test('the trailing pill appears only when there is something to say', () => {
  expect(holiMeta(row({ label: 'Write the retro', type: 'holi-task-todo' }))).toBeNull()
  const node = holiMeta(
    row({ label: 'Write the retro', type: 'holi-task-todo', meta: 'due 18 Sep' }),
  )
  expect((node as HTMLElement).textContent).toBe('due 18 Sep')
})

// CodeMirror moves the selection by toggling `aria-selected` and does NOT
// re-render the rows, so a hint rendered only for the selected row would go
// stale the moment you pressed an arrow key. It is rendered always and shown
// by CSS.
test('the enter hint is rendered on every row of ours, not just the selected one', () => {
  expect(holiEnterHint(row({ label: '/todo', type: 'holi-list-todo' }))).not.toBeNull()
  expect(holiEnterHint(row({ label: '2x2', type: 'table' }))).toBeNull()
})
