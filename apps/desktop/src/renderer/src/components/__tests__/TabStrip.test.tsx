/**
 * The strip's drag wiring — and only the wiring.
 *
 * jsdom has neither `DragEvent` nor `DataTransfer`, and it computes no layout,
 * so every pill measures `0×0` here. What this file can honestly check is that
 * the pill offers itself to a drag, that the right payload goes on the wire,
 * that a `dragover` carrying a tab is `preventDefault`ed (without which the drop
 * never fires at all), and that a drop hands the parsed tab back.
 *
 * Where the caret actually lands is `test/tab-drop.test.ts`, on numbers. That
 * split is the whole reason `lib/tab-drop.ts` exists.
 */
import { act, fireEvent, render, screen } from '@/test/render'
import { expect, test, vi } from 'vitest'
import { TAB_MIME, parseTabPayload } from '@/lib/tab-drop'
import type { Tab } from '@/state/panes'
import { TabStrip } from '../TabStrip'

/** Enough of `DataTransfer` for the handlers under test. jsdom ships none. */
class FakeDataTransfer {
  private readonly store = new Map<string, string>()
  dropEffect = 'none'
  effectAllowed = 'uninitialized'
  setData(type: string, value: string): void {
    this.store.set(type, value)
  }
  getData(type: string): string {
    return this.store.get(type) ?? ''
  }
  get types(): string[] {
    return [...this.store.keys()]
  }
}

/** A drag event React will route to its synthetic handlers. Built by hand
 *  rather than through `fireEvent.dragStart`, so the test does not depend on
 *  how Testing Library papers over jsdom's missing `DragEvent`. */
function dragEvent(type: string, dataTransfer: FakeDataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  Object.defineProperty(event, 'clientX', { value: 0 })
  return event
}

const tabs: Tab[] = [
  { kind: 'note', path: 'notes/a.md' },
  { kind: 'note', path: 'notes/b.md' },
]

/** `active={0}` is load-bearing: with nothing measurable, `tabWindow` reserves
 *  room for the "+N" control, finds that nothing fits, and falls back to a
 *  window of exactly one tab — the active one. So only the active pill is ever
 *  in the DOM here, which is another thing jsdom cannot show us. */
function strip(onDropTab = vi.fn()) {
  render(
    <TabStrip
      tabs={tabs}
      active={0}
      onSelect={() => {}}
      onPin={() => {}}
      onClose={() => {}}
      onDropTab={onDropTab}
    />,
  )
  return { onDropTab, host: screen.getByTestId('tab-strip') }
}

/** The pill, not the button inside it — `draggable` belongs on the outer span. */
const pillFor = (name: string) => screen.getByText(name).closest('[draggable]')

test('a pill offers itself to a drag', () => {
  strip()

  expect(pillFor('a.md')).not.toBeNull()
})

test('the drag carries the tab’s identity under the custom MIME type', () => {
  strip()
  const dataTransfer = new FakeDataTransfer()

  fireEvent(pillFor('a.md')!, dragEvent('dragstart', dataTransfer))

  expect(parseTabPayload(dataTransfer.getData(TAB_MIME))).toEqual({
    kind: 'note',
    path: 'notes/a.md',
  })
  expect(dataTransfer.effectAllowed).toBe('move')
})

test('a dragover carrying a tab is accepted', () => {
  // `preventDefault` on dragover is what makes an element a drop target at all.
  // Without it the drop event never fires, which is the single most common way
  // HTML5 drag-and-drop silently does nothing.
  const { host } = strip()
  const dataTransfer = new FakeDataTransfer()
  dataTransfer.setData(TAB_MIME, '{"kind":"note","path":"notes/a.md"}')

  const event = dragEvent('dragover', dataTransfer)
  fireEvent(host, event)

  expect(event.defaultPrevented).toBe(true)
  expect(dataTransfer.dropEffect).toBe('move')
})

test('a dragover carrying something else is not', () => {
  // A task card dragged from the board must not make the strip look droppable.
  const { host } = strip()
  const dataTransfer = new FakeDataTransfer()
  dataTransfer.setData('text/plain', 'tasks/whatever.md')

  const event = dragEvent('dragover', dataTransfer)
  fireEvent(host, event)

  expect(event.defaultPrevented).toBe(false)
})

test('a drop hands back the tab that was dragged', () => {
  const { host, onDropTab } = strip()
  const dataTransfer = new FakeDataTransfer()
  dataTransfer.setData(TAB_MIME, '{"kind":"note","path":"notes/a.md"}')

  fireEvent(host, dragEvent('drop', dataTransfer))

  // The index is not asserted: every rect is 0×0 here, so it carries no
  // meaning. `test/tab-drop.test.ts` is where the index is checked.
  expect(onDropTab).toHaveBeenCalledWith({ kind: 'note', path: 'notes/a.md' }, expect.any(Number))
})

test('a drop carrying junk is ignored rather than guessed at', () => {
  const { host, onDropTab } = strip()
  const dataTransfer = new FakeDataTransfer()
  dataTransfer.setData(TAB_MIME, 'not a tab')

  fireEvent(host, dragEvent('drop', dataTransfer))

  expect(onDropTab).not.toHaveBeenCalled()
})

/* ── Auto-slide ──────────────────────────────────────────────────────────
 *
 * jsdom cannot *compute* layout, but a test can *supply* it. Stubbing the two
 * measurements the strip actually takes — `clientWidth` for the space it has and
 * `getBoundingClientRect` for each pill — is enough to make the window clip for
 * real, and what is under test here is the state machine, not the arithmetic:
 * does a hover at the edge advance, does the continuous `dragover` stream reset
 * the timer, does the window follow. The geometry itself is checked on numbers
 * in `test/tab-drop.test.ts`.
 * ───────────────────────────────────────────────────────────────────── */

/** Five tabs, 60px each, in a 200px strip — so only two fit and three are hidden. */
const manyTabs: Tab[] = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].map((name) => ({
  kind: 'note',
  path: `notes/${name}`,
}))

const PILL_WIDTH = 60
const STRIP_WIDTH = 200

function withFakeLayout(): () => void {
  const rect = HTMLElement.prototype.getBoundingClientRect
  const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')

  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    const box = {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: PILL_WIDTH,
      bottom: 24,
      width: PILL_WIDTH,
      height: 24,
    }
    return { ...box, toJSON: () => box } as DOMRect
  }
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get: () => STRIP_WIDTH,
  })

  return () => {
    HTMLElement.prototype.getBoundingClientRect = rect
    if (clientWidth !== undefined) {
      Object.defineProperty(Element.prototype, 'clientWidth', clientWidth)
    }
  }
}

/** With every pill 60px wide the host's stubbed rect is 60 too, so anything past
 *  its midpoint is inside the 28px right-hand band. */
const AT_RIGHT_EDGE = 50

test('hovering the clipped edge slides the window to reach a hidden position', () => {
  const restore = withFakeLayout()
  vi.useFakeTimers()
  try {
    render(
      <TabStrip
        tabs={manyTabs}
        active={0}
        onSelect={() => {}}
        onPin={() => {}}
        onClose={() => {}}
        onDropTab={vi.fn()}
      />,
    )
    // Two of five fit, and the active tab anchors the window to the left.
    expect(screen.getByText('a.md')).toBeInTheDocument()
    expect(screen.queryByText('c.md')).not.toBeInTheDocument()

    const host = screen.getByTestId('tab-strip')
    const dataTransfer = new FakeDataTransfer()
    dataTransfer.setData(TAB_MIME, '{"kind":"note","path":"notes/a.md"}')

    const hover = () => {
      const event = new Event('dragover', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      Object.defineProperty(event, 'clientX', { value: AT_RIGHT_EDGE })
      fireEvent(host, event)
    }

    // Arriving at the edge steps once immediately, rather than doing nothing for
    // a full interval first.
    act(() => hover())
    expect(screen.getByText('c.md')).toBeInTheDocument()
    expect(screen.queryByText('a.md')).not.toBeInTheDocument()

    // `dragover` fires continuously. A second one at the same edge must NOT
    // re-arm: restarting the timer on every event would reset it forever and the
    // strip would freeze one step from where it started.
    act(() => hover())
    // Still showing b+c. If the second hover had re-armed, it would have stepped
    // again and the window would be c+d — which is why this asserts the tab that
    // would have been dropped, not the one that survives either way.
    expect(screen.getByText('b.md')).toBeInTheDocument()

    act(() => void vi.advanceTimersByTime(400))
    expect(screen.getByText('d.md')).toBeInTheDocument()
    expect(screen.queryByText('b.md')).not.toBeInTheDocument()
  } finally {
    vi.useRealTimers()
    restore()
  }
})

test('the slide stops when the drag leaves, and takes its timer with it', () => {
  const restore = withFakeLayout()
  vi.useFakeTimers()
  try {
    render(
      <TabStrip
        tabs={manyTabs}
        active={0}
        onSelect={() => {}}
        onPin={() => {}}
        onClose={() => {}}
        onDropTab={vi.fn()}
      />,
    )
    const host = screen.getByTestId('tab-strip')
    const dataTransfer = new FakeDataTransfer()
    dataTransfer.setData(TAB_MIME, '{"kind":"note","path":"notes/a.md"}')

    const event = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    Object.defineProperty(event, 'clientX', { value: AT_RIGHT_EDGE })
    act(() => void fireEvent(host, event))
    expect(screen.getByText('c.md')).toBeInTheDocument()

    // `relatedTarget` outside the host is a real leave, not a child crossing.
    act(() => void fireEvent.dragLeave(host, { relatedTarget: document.body }))

    // The window is back on the active tab, and no timer is still running.
    expect(screen.getByText('a.md')).toBeInTheDocument()
    act(() => void vi.advanceTimersByTime(2000))
    expect(screen.getByText('a.md')).toBeInTheDocument()
  } finally {
    vi.useRealTimers()
    restore()
  }
})
