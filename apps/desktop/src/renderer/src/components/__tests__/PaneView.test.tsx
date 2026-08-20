/**
 * The pane body as a drop surface.
 *
 * The content used to sit directly inside `<main>`; taking drops meant wrapping
 * it so an overlay has somewhere to be absolutely positioned. That wrapper is
 * the risk this file covers — a flex child that forgot `min-h-0` or `flex-1`
 * collapses the editor to nothing, and no other test renders a pane at all.
 *
 * What the overlay *decides* is `paneDropZone`, tested on numbers in
 * `test/tab-drop.test.ts`. jsdom measures every rect as `0×0`, so a zone read
 * here would be an assertion about zero.
 */
import { fireEvent, render, screen } from '@/test/render'
import { expect, test, vi } from 'vitest'
import { TAB_MIME } from '@/lib/tab-drop'
import type { Pane } from '@/state/panes'
import { PaneView } from '../PaneView'

/** Empty, so the body renders the empty-editor placeholder rather than mounting
 *  the whole CodeMirror stack — the wrapper is what is under test. */
const empty: Pane = { tabs: [], active: -1 }

function pane(props: Partial<Parameters<typeof PaneView>[0]> = {}) {
  const onDropTab = vi.fn()
  const onDropEdge = vi.fn()
  render(
    <PaneView
      pane={empty}
      focused
      onFocus={() => {}}
      onSelect={() => {}}
      onPin={() => {}}
      onCloseTab={() => {}}
      onEdit={() => {}}
      onOpenNote={() => {}}
      onConflict={() => {}}
      onDropTab={onDropTab}
      onDropEdge={onDropEdge}
      {...props}
    />,
  )
  return { onDropTab, onDropEdge }
}

function dragEnter(types: string[]) {
  const body = screen.getByTestId('tab-strip').parentElement!.nextElementSibling!
  const event = new Event('dragenter', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types, getData: () => '', dropEffect: 'none' },
  })
  Object.defineProperty(event, 'clientX', { value: 0 })
  fireEvent(body, event)
  return body
}

test('the pane still renders its strip and its body', () => {
  pane()

  expect(screen.getByTestId('tab-strip')).toBeInTheDocument()
  // The wrapper must not have swallowed the content.
  expect(screen.getByText('select or create a note')).toBeInTheDocument()
})

test('a tab dragged over the body lights it up as a drop target', () => {
  pane()
  expect(screen.queryByTestId('pane-drop-overlay')).not.toBeInTheDocument()

  dragEnter([TAB_MIME])

  expect(screen.getByTestId('pane-drop-overlay')).toBeInTheDocument()
})

test('a drag that is not a tab leaves the pane inert', () => {
  // A file from the tree, or a task card off the board, must not make the
  // editor body look like it will accept them.
  pane()

  dragEnter(['text/plain'])

  expect(screen.queryByTestId('pane-drop-overlay')).not.toBeInTheDocument()
})

test('a pane wired for no drops never offers one', () => {
  pane({ onDropTab: undefined, onDropEdge: undefined })

  dragEnter([TAB_MIME])

  expect(screen.queryByTestId('pane-drop-overlay')).not.toBeInTheDocument()
})
