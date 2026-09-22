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
import { TAB_MIME, type PaneDropZone } from '@/lib/tab-drop'
import type { Pane, Tab } from '@/state/panes'
import { PaneView } from '../PaneView'

// The terminal is stubbed: xterm needs measured geometry jsdom does not have,
// and what a terminal does with its own bytes is `SessionTerminal`'s business.
vi.mock('@/features/agent/SessionTerminal', () => ({
  SessionTerminal: ({ sessionId, visible }: { sessionId: string; visible: boolean }) => (
    <div data-terminal={sessionId} data-visible={visible} />
  ),
}))
vi.mock('@/features/agent/TurnChip', () => ({ TurnChip: () => <div data-turn-chip /> }))
// The PDF viewer is embedpdf over a wasm engine; these tests open `.pdf` tabs
// precisely so the pane body is cheap, so it is a stub here too.
vi.mock('@/features/files/PdfViewer', () => ({
  PdfViewer: ({ path }: { path: string }) => <div data-pdf-viewer={path} />,
}))

/** Empty, so the body renders the empty-editor placeholder rather than mounting
 *  the whole CodeMirror stack — the wrapper is what is under test. */
const empty: Pane = { tabs: [], active: -1 }

const ALL: PaneDropZone[] = ['before', 'into', 'after']

function pane(props: Partial<Parameters<typeof PaneView>[0]> = {}) {
  const onDropTab = vi.fn()
  const onDropEdge = vi.fn()
  render(
    <PaneView
      pane={empty}
      allowed={ALL}
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

/** A `.pdf` note renders the stubbed `PdfViewer` above, so a pane can hold
 *  real tabs here without mounting the editor stack. */
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

test('the pane still renders its strip and its body', () => {
  pane()

  expect(screen.getByTestId('tab-strip')).toBeInTheDocument()
  // The wrapper must not have swallowed the content.
  expect(screen.getByText('select or create a note')).toBeInTheDocument()
})

test('a dragover carrying something other than a tab is refused', () => {
  // Shell only reports a drag when a tab pill starts one, so a file from the
  // tree never reaches here — but the overlay checks anyway, because
  // `preventDefault` is what makes an element a drop target and it must not be
  // handed out on a guess.
  pane()
  const overlay = screen.getByTestId('pane-drop-overlay')

  const over = new Event('dragover', { bubbles: true, cancelable: true })
  Object.defineProperty(over, 'dataTransfer', {
    value: { types: ['text/plain'], getData: () => '', dropEffect: 'none' },
  })
  Object.defineProperty(over, 'clientX', { value: 0 })
  fireEvent(overlay, over)

  expect(over.defaultPrevented).toBe(false)
})

test('a pane offers nothing when it is handed no zones', () => {
  // `dropZones` decides this — a sole tab's own pane, and the facing edge of the
  // pane next door, are all no-ops. The component's job is to believe it.
  pane({ pane: { tabs: [note('only')], active: 0 }, allowed: [] })

  dragFromOwnStrip()

  expect(screen.queryByTestId('pane-drop-overlay')).not.toBeInTheDocument()
})

test('a pane handed only edges keeps them and refuses its middle', () => {
  pane({ pane: { tabs: [note('a'), note('b')], active: 0 }, allowed: ['before', 'after'] })

  dragFromOwnStrip()
  const overlay = screen.getByTestId('pane-drop-overlay')
  const over = new Event('dragover', { bubbles: true, cancelable: true })
  Object.defineProperty(over, 'dataTransfer', {
    value: { types: [TAB_MIME], getData: () => '', dropEffect: 'none' },
  })
  // jsdom measures 0x0, so `paneDropZone` reads the middle here.
  Object.defineProperty(over, 'clientX', { value: 0 })
  fireEvent(overlay, over)

  expect(screen.getByTestId('pane-drop-before')).toBeInTheDocument()
  expect(screen.getByTestId('pane-drop-after')).toBeInTheDocument()
  expect(screen.queryByTestId('pane-drop-into')).not.toBeInTheDocument()
  expect(over.defaultPrevented).toBe(false)
})

test('a pane handed all three accepts its middle', () => {
  pane({ pane: { tabs: [note('a')], active: 0 } })

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

test('the landing strips are on screen before the pointer arrives', () => {
  // No dragenter and no dragover: being handed zones is enough. The
  // discoverability rule — an edge that only exists once you are in it teaches
  // nobody that a drag can split the view.
  pane({ pane: { tabs: [note('a'), note('b')], active: 0 }, allowed: ['before', 'after'] })

  expect(screen.getByTestId('pane-drop-before')).toBeInTheDocument()
  expect(screen.getByTestId('pane-drop-after')).toBeInTheDocument()
})

test('a drag starting in this strip reports the tab it picked up', () => {
  const onDragBegin = vi.fn()
  pane({ pane: { tabs: [note('a'), note('b')], active: 0 }, onDragBegin })

  dragFromOwnStrip()

  expect(onDragBegin).toHaveBeenCalledWith({ kind: 'note', path: 'notes/a.pdf' })
})

/**
 * Leaving a split.
 *
 * React unmounts a pane the instant state says it is gone, so the exit cannot
 * live on the removal — the shell holds the close for `--motion-leave` and marks
 * the pane `leaving` meanwhile. What this file can check is the half that lives
 * here: the class goes on, and the pane stops taking input while it runs. A pane
 * you have already closed accepting a click would be worse than no animation.
 */
test('a pane on its way out plays the exit and stops taking input', () => {
  pane({ leaving: true })

  const main = screen.getByTestId('tab-strip').closest('main')!
  expect(main).toHaveClass('motion-out-origin')
  expect(main).toHaveClass('pointer-events-none')
})

test('a pane that is staying is untouched', () => {
  pane()

  const main = screen.getByTestId('tab-strip').closest('main')!
  expect(main).not.toHaveClass('motion-out-origin')
  expect(main).not.toHaveClass('pointer-events-none')
})

test('keeps every session tab’s terminal mounted, showing only the active one', () => {
  // A terminal unmounted on a tab switch throws away its scrollback and has to
  // replay main's mirror to get it back, which is a repaint you can see. This is
  // the rule the drawer's strip enforced; the pane enforces it now (D101).
  pane({
    pane: {
      tabs: [
        { kind: 'session', id: 'a' },
        { kind: 'session', id: 'b' },
      ],
      active: 1,
    },
  })

  expect(document.querySelector('[data-terminal="a"]')?.getAttribute('data-visible')).toBe('false')
  expect(document.querySelector('[data-terminal="b"]')?.getAttribute('data-visible')).toBe('true')
})

test('a session tab shows its terminal instead of the editor', () => {
  pane({ pane: { tabs: [{ kind: 'session', id: 'a' }], active: 0 } })

  expect(document.querySelector('[data-terminal="a"]')).not.toBeNull()
  expect(screen.queryByText('select or create a note')).not.toBeInTheDocument()
})

test('a note tab beside a session keeps the session’s terminal alive', () => {
  // Switching to a note is a tab switch like any other: the PTY is main's and
  // keeps running, and the terminal it is attached to must not go with the view.
  pane({ pane: { tabs: [{ kind: 'session', id: 'a' }, note('plan')], active: 1 } })

  expect(document.querySelector('[data-terminal="a"]')?.getAttribute('data-visible')).toBe('false')
})
