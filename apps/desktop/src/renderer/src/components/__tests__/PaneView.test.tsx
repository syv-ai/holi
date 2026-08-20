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
import type { Pane, Tab } from '@/state/panes'
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

/** A `.pdf` note renders `FilePlaceholder` — a pure component — so a pane can
 *  hold real tabs here without mounting the editor stack. */
const note = (name: string): Tab => ({ kind: 'note', path: `notes/${name}.pdf` })

/** Pick a pill up from this pane's own strip, which is what tells the pane the
 *  drag started here. */
function dragFromOwnStrip() {
  const pill = screen.getByTestId('tab-strip').querySelector('[draggable]')!
  const event = new Event('dragstart', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { setData: () => {}, getData: () => '', types: [TAB_MIME], effectAllowed: 'none' },
  })
  fireEvent(pill, event)
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

test('a pane offers nothing when the tab being dragged is its only one', () => {
  // Every zone would be a no-op: the edges are the sole-tab-on-its-own-edge
  // case, and the middle is a same-pane move to where it already is. Lighting
  // any of them promises something that cannot happen.
  pane({ pane: { tabs: [note('only')], active: 0 } })

  dragFromOwnStrip()
  dragEnter([TAB_MIME])

  expect(screen.queryByTestId('pane-drop-overlay')).not.toBeInTheDocument()
})

test('the pane a drag came from keeps its edges but drops its middle', () => {
  // Reaching either edge means crossing the body, so a full-pane highlight
  // would flash on every split gesture — and "into my own pane" is a move to
  // the end of my own strip, which the strip already expresses.
  pane({ pane: { tabs: [note('a'), note('b')], active: 0 } })

  dragFromOwnStrip()
  const body = dragEnter([TAB_MIME])
  const overlay = screen.getByTestId('pane-drop-overlay')

  // jsdom measures 0x0, so `paneDropZone` reads the middle here.
  const over = new Event('dragover', { bubbles: true, cancelable: true })
  Object.defineProperty(over, 'dataTransfer', {
    value: { types: [TAB_MIME], getData: () => '', dropEffect: 'none' },
  })
  Object.defineProperty(over, 'clientX', { value: 0 })
  fireEvent(overlay, over)

  // Both landing strips are on screen, but the middle itself draws nothing and
  // refuses the drop.
  expect(screen.getByTestId('pane-drop-before')).toBeInTheDocument()
  expect(screen.getByTestId('pane-drop-after')).toBeInTheDocument()
  expect(screen.queryByTestId('pane-drop-into')).not.toBeInTheDocument()
  expect(over.defaultPrevented).toBe(false)
  expect(body).toBeInstanceOf(HTMLElement)
})

test('another pane still offers all three zones', () => {
  // The drag did not start here, so "put this over there" is exactly what the
  // middle means, and it keeps its highlight.
  pane({ pane: { tabs: [note('a')], active: 0 } })

  dragEnter([TAB_MIME])
  const overlay = screen.getByTestId('pane-drop-overlay')
  const over = new Event('dragover', { bubbles: true, cancelable: true })
  Object.defineProperty(over, 'dataTransfer', {
    value: { types: [TAB_MIME], getData: () => '', dropEffect: 'none' },
  })
  Object.defineProperty(over, 'clientX', { value: 0 })
  fireEvent(overlay, over)

  expect(over.defaultPrevented).toBe(true)
  expect(screen.getByTestId('pane-drop-into')).toBeInTheDocument()
})

test('both landing strips appear the moment a tab is picked up', () => {
  // The discoverability rule: an edge that only exists once the pointer is
  // already in it teaches nobody that a drag can split the view.
  pane({ pane: { tabs: [note('a'), note('b')], active: 0 } })
  expect(screen.queryByTestId('pane-drop-before')).not.toBeInTheDocument()

  dragFromOwnStrip()

  // No dragenter, no dragover — picking the tab up was enough.
  expect(screen.getByTestId('pane-drop-before')).toBeInTheDocument()
  expect(screen.getByTestId('pane-drop-after')).toBeInTheDocument()
})

test('a tab picked up in ANOTHER pane arms this one too', () => {
  // `dragstart` bubbles to the window, which is how a pane hears about a drag
  // that began somewhere it cannot see.
  pane({ pane: { tabs: [note('a')], active: 0 } })

  const event = new Event('dragstart', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: [TAB_MIME] } })
  fireEvent(document.body, event)

  expect(screen.getByTestId('pane-drop-before')).toBeInTheDocument()
  expect(screen.getByTestId('pane-drop-after')).toBeInTheDocument()
})

test('a drag of something else arms nothing', () => {
  pane({ pane: { tabs: [note('a'), note('b')], active: 0 } })

  const event = new Event('dragstart', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['text/plain'] } })
  fireEvent(document.body, event)

  expect(screen.queryByTestId('pane-drop-overlay')).not.toBeInTheDocument()
})
