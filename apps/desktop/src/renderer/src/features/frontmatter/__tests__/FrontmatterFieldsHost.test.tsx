import { afterEach, expect, test } from 'vitest'
// The app's wrapped render: FrontmatterFields draws Tooltips and Selects, which
// need the providers the shell mounts.
import { act, render } from '@/test/render'
import {
  closeFrontmatterPortal,
  openFrontmatterPortal,
  updateFrontmatterPortal,
} from '@/editor/frontmatter-portals'
import { FrontmatterFieldsHost } from '../FrontmatterFieldsHost'

const opened: number[] = []

/** A container the way a CodeMirror widget publishes one: empty, in the DOM. */
function publish(yaml = 'status: todo\n') {
  const el = document.createElement('div')
  el.className = 'cm-fm-fields'
  document.body.appendChild(el)
  let id = 0
  act(() => {
    id = openFrontmatterPortal({ el, path: 'tasks/ship.md', yaml, write: () => {} })
  })
  opened.push(id)
  return { el, id }
}

afterEach(() => {
  act(() => {
    for (const id of opened.splice(0)) closeFrontmatterPortal(id)
  })
  document.body.innerHTML = ''
})

/**
 * The blink this exists to remove: CodeMirror builds the container in `toDOM`
 * and paints it, and React can only fill it on a later tick, so switching
 * between two task files collapsed the block to nothing and snapped it back.
 * The block is filled in the same commit it is published, and without a fade:
 * the note it belongs to does not fade either.
 */
test('a block is filled the moment it is published, without a fade', () => {
  render(<FrontmatterFieldsHost />)
  const { el } = publish()

  expect(el.childElementCount).toBeGreaterThan(0)
  expect(el).not.toHaveClass('motion-in-fade')
})

/**
 * Editing a field writes back through the widget, which maps its decoration
 * rather than rebuilding it — so the container survives and only the yaml
 * changes.
 */
test('editing a field keeps the block and its contents', () => {
  render(<FrontmatterFieldsHost />)
  const { el, id } = publish('status: todo\n')

  act(() => updateFrontmatterPortal(id, 'status: doing\n'))
  expect(el.isConnected).toBe(true)
  expect(el.childElementCount).toBeGreaterThan(0)
})

test('a different block gets its own fields', () => {
  render(<FrontmatterFieldsHost />)
  const first = publish()
  const second = publish('status: done\n')

  expect(first.el.childElementCount).toBeGreaterThan(0)
  expect(second.el.childElementCount).toBeGreaterThan(0)
})
