/**
 * The pane body as a drop surface. The risk covered is the wrapper the overlay
 * needs: a flex child missing `min-h-0` or `flex-1` collapses the editor, and
 * no other test renders a pane. What the overlay decides is `paneDropZone`,
 * tested on numbers in `test/tab-drop.test.ts`.
 */
import { fireEvent, render, screen } from '@/test/render'
import { expect, test, vi } from 'vitest'
import { TAB_MIME, type PaneDropZone } from '@/lib/tab-drop'
import type { Pane, Tab } from '@/state/panes'
import { PaneView } from '../PaneView'

// The terminal is stubbed: xterm needs geometry jsdom does not have.
vi.mock('@/features/agent/SessionTerminal', () => ({
  SessionTerminal: ({ terminalId, visible }: { terminalId: string; visible: boolean }) => (
    <div data-terminal={terminalId} data-visible={visible} />
  ),
}))
vi.mock('@/features/agent/TurnChip', () => ({ TurnChip: () => <div data-turn-chip /> }))
// Stubbed too: these tests open `.pdf` tabs precisely so the body is cheap.
vi.mock('@/features/files/PdfViewer', () => ({
  PdfViewer: ({ path }: { path: string }) => <div data-pdf-viewer={path} />,
}))

/** Empty, so the body renders the placeholder rather than CodeMirror. */
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

/** Pick a pill up from this pane's own strip. */
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
  // Shell only reports tab drags, but the overlay checks the type anyway before
  // making itself a drop target.
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
  // `dropZones` decides which zones are no-ops; the component believes it.
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
  // No dragenter or dragover: being handed zones is enough, so the edges are
  // discoverable.
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
 * The shell holds the close for `--motion-leave` and marks the pane `leaving`.
 * Checked here: the class goes on, and the pane stops taking input.
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

test('keeps every agent tab’s terminal mounted, showing only the active one', () => {
  // An unmounted terminal loses its scrollback and must visibly replay main's
  // mirror (D110).
  pane({
    pane: {
      tabs: [
        { kind: 'agent', id: 'a' },
        { kind: 'agent', id: 'b' },
      ],
      active: 1,
    },
  })

  expect(document.querySelector('[data-terminal="a"]')?.getAttribute('data-visible')).toBe('false')
  expect(document.querySelector('[data-terminal="b"]')?.getAttribute('data-visible')).toBe('true')
})

test('an agent tab shows its terminal instead of the editor', () => {
  pane({ pane: { tabs: [{ kind: 'agent', id: 'a' }], active: 0 } })

  expect(document.querySelector('[data-terminal="a"]')).not.toBeNull()
  expect(screen.queryByText('select or create a note')).not.toBeInTheDocument()
})

test('a note tab beside an agent tab keeps its terminal alive', () => {
  // The PTY keeps running, so its terminal must survive switching to a note.
  pane({ pane: { tabs: [{ kind: 'agent', id: 'a' }, note('plan')], active: 1 } })

  expect(document.querySelector('[data-terminal="a"]')?.getAttribute('data-visible')).toBe('false')
})
