/**
 * The popup's rows, and the guard that keeps their glyphs honest.
 *
 * A CodeMirror option is built with `document.createElement`, so these
 * renderers are plain DOM and testable without an editor. The drift guard
 * renders the real `lucide-react` component and compares its shapes to the
 * geometry we hand-copied, because `lucide-react` exports components and not
 * geometry, and no React lives inside CodeMirror anywhere in this app.
 */
import { expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Circle, CircleCheck, CircleDot, FileText, ListTodo, Settings2, Table } from 'lucide-react'
import type { ComponentType } from 'react'
import { GLYPHS } from '../completion-icons'
import { holiIcon, holiMeta, holiEnterHint, type HoliCompletion } from '../completion'

// Typed, not inferred: `emoji` and `meta` are ours, and an object literal
// widened to CodeMirror's `Completion` would be rejected for carrying them.
const row = (c: HoliCompletion): HoliCompletion => c

/** Every shape in an SVG fragment, as comparable strings. */
function shapes(fragment: string): string[] {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${fragment}</svg>`,
    'image/svg+xml',
  )
  return [...doc.documentElement.children].map(
    (el) =>
      `${el.tagName}:${[...el.attributes]
        .map((a) => `${a.name}=${a.value}`)
        .sort()
        .join(',')}`,
  )
}

const PAIRS: [string, ComponentType][] = [
  ['holi-note', FileText],
  ['holi-task-todo', Circle],
  ['holi-task-doing', CircleDot],
  ['holi-task-done', CircleCheck],
  ['holi-list-todo', ListTodo],
  ['holi-table', Table],
  ['holi-setting', Settings2],
]

test.each(PAIRS)('%s is the same glyph lucide draws', (key, Icon) => {
  const markup = renderToStaticMarkup(<Icon />)
  const inner = markup.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')
  expect(shapes(GLYPHS[key]!)).toEqual(shapes(inner))
})

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
