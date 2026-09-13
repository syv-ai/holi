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
 */
test('a block opens rather than appearing at full height', () => {
  render(<FrontmatterFieldsHost />)
  const { el } = publish()

  expect(el).toHaveClass('motion-in-row')
  expect(el.childElementCount).toBeGreaterThan(0)
})

/**
 * Editing a field writes back through the widget, which maps its decoration
 * rather than rebuilding it — so the container survives and only the yaml
 * changes. Re-opening the block on every keystroke would be worse than the bug.
 */
test('editing a field does not re-open the block', () => {
  render(<FrontmatterFieldsHost />)
  const { el, id } = publish('status: todo\n')

  act(() => {
    el.dispatchEvent(new Event('animationend', { bubbles: true }))
  })
  expect(el).not.toHaveClass('motion-in-row')

  act(() => updateFrontmatterPortal(id, 'status: doing\n'))
  expect(el).not.toHaveClass('motion-in-row')
})

test('a different block gets its own opening', () => {
  render(<FrontmatterFieldsHost />)
  const first = publish()
  act(() => {
    first.el.dispatchEvent(new Event('animationend', { bubbles: true }))
  })

  const second = publish('status: done\n')
  expect(second.el).toHaveClass('motion-in-row')
  expect(first.el).not.toHaveClass('motion-in-row')
})
