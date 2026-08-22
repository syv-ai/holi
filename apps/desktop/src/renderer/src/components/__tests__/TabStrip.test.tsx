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
import userEvent from '@testing-library/user-event'
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

/** Both pills are in the DOM: the strip lays every tab out and scrolls, so
 *  nothing is conditionally rendered any more. They all measure 0×0, which is
 *  what keeps the drop *index* out of these assertions. */
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

/* ── Auto-scroll, and the per-side counts ────────────────────────────────
 *
 * jsdom cannot *compute* layout, but a test can *supply* it. Stubbing the four
 * measurements the strip actually takes — `clientWidth` for the viewport,
 * `getBoundingClientRect` for hit-testing, and `offsetLeft`/`offsetWidth` for
 * where each pill sits in the scroll content — is enough to make the strip
 * overflow for real. What is under test here is the wiring and the state
 * machine, not the arithmetic: `test/tab-overflow.test.ts` owns which tabs are
 * off which edge, and `test/tab-drop.test.ts` owns where a drop lands.
 *
 * `scrollLeft` needs supplying too. jsdom has no layout box, so scrolling an
 * element is specified to do nothing at all and the property is permanently 0 —
 * an own accessor on the host shadows it and records what the strip asks for.
 * ───────────────────────────────────────────────────────────────────── */

/** Five tabs, 60px each, in a 200px strip: three fit, two hang off the right. */
const manyTabs: Tab[] = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].map((name) => ({
  kind: 'note',
  path: `notes/${name}`,
}))

const PILL_WIDTH = 60
const STRIP_WIDTH = 200

function withFakeLayout(): () => void {
  const rect = HTMLElement.prototype.getBoundingClientRect
  const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')
  const offsetLeft = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft')
  const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')

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
  // Only the pills have a place in the scroll content; `draggable` is what marks
  // one, and their order in the host is their order in the strip.
  const pillIndex = (el: HTMLElement): number =>
    el.parentElement === null
      ? -1
      : [...el.parentElement.querySelectorAll('[draggable]')].indexOf(el)
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
    configurable: true,
    get(this: HTMLElement) {
      const i = this.hasAttribute('draggable') ? pillIndex(this) : -1
      return i < 0 ? 0 : i * PILL_WIDTH
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('draggable') ? PILL_WIDTH : 0
    },
  })

  return () => {
    HTMLElement.prototype.getBoundingClientRect = rect
    if (clientWidth !== undefined) Object.defineProperty(Element.prototype, 'clientWidth', clientWidth)
    if (offsetLeft !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetLeft', offsetLeft)
    if (offsetWidth !== undefined)
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
  }
}

/** Give the host a `scrollLeft` that remembers, and read it back. */
function trackScroll(host: HTMLElement): () => number {
  let value = 0
  Object.defineProperty(host, 'scrollLeft', {
    configurable: true,
    get: () => value,
    set: (next: number) => {
      value = next
    },
  })
  return () => value
}

/** With every stubbed rect 60px wide, anything past its midpoint is inside the
 *  28px right-hand band. */
const AT_RIGHT_EDGE = 50

function manyStrip(onSelect = vi.fn()) {
  render(
    <TabStrip
      tabs={manyTabs}
      active={0}
      onSelect={onSelect}
      onPin={() => {}}
      onClose={() => {}}
      onDropTab={vi.fn()}
    />,
  )
  return { onSelect, host: screen.getByTestId('tab-strip') }
}

/** A `dragover` at the strip's right-hand edge, carrying a tab. */
function hoverRightEdge(host: HTMLElement, dataTransfer: FakeDataTransfer): void {
  const event = new Event('dragover', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  Object.defineProperty(event, 'clientX', { value: AT_RIGHT_EDGE })
  fireEvent(host, event)
}

const tabDrag = () => {
  const dataTransfer = new FakeDataTransfer()
  dataTransfer.setData(TAB_MIME, '{"kind":"note","path":"notes/a.md"}')
  return dataTransfer
}

test('hovering an end scrolls the strip, and the first step lands immediately', () => {
  const restore = withFakeLayout()
  vi.useFakeTimers()
  try {
    const { host } = manyStrip()
    const scrollLeft = trackScroll(host)
    const dataTransfer = tabDrag()

    // Arriving at the edge steps once, rather than doing nothing for a whole
    // interval first.
    act(() => hoverRightEdge(host, dataTransfer))
    const afterFirst = scrollLeft()
    expect(afterFirst).toBeGreaterThan(0)

    // `dragover` fires continuously. A second one at the same edge must NOT
    // re-arm: restarting the interval on each event would reset it forever and
    // the strip would freeze one step from where it started.
    act(() => hoverRightEdge(host, dataTransfer))
    expect(scrollLeft()).toBe(afterFirst)

    act(() => void vi.advanceTimersByTime(200))
    expect(scrollLeft()).toBeGreaterThan(afterFirst)
  } finally {
    vi.useRealTimers()
    restore()
  }
})

test('the scroll stops when the drag leaves, and takes its timer with it', () => {
  const restore = withFakeLayout()
  vi.useFakeTimers()
  try {
    const { host } = manyStrip()
    const scrollLeft = trackScroll(host)

    act(() => hoverRightEdge(host, tabDrag()))
    const moved = scrollLeft()
    expect(moved).toBeGreaterThan(0)

    // `relatedTarget` outside the host is a real leave, not a child crossing.
    act(() => void fireEvent.dragLeave(host, { relatedTarget: document.body }))

    act(() => void vi.advanceTimersByTime(2000))
    expect(scrollLeft()).toBe(moved)
  } finally {
    vi.useRealTimers()
    restore()
  }
})

test('a vertical wheel scrolls the strip sideways', () => {
  // A mouse without a horizontal wheel would otherwise have no gesture at all,
  // and there is nothing to scroll vertically in a one-line row.
  const restore = withFakeLayout()
  try {
    const { host } = manyStrip()
    const scrollLeft = trackScroll(host)

    fireEvent.wheel(host, { deltaY: 120, deltaX: 0 })

    expect(scrollLeft()).toBe(120)
  } finally {
    restore()
  }
})

test('tabs past an edge are counted on the side they went', () => {
  const restore = withFakeLayout()
  try {
    const { host } = manyStrip()
    trackScroll(host)

    // 200px of viewport holds three 60px pills; d.md and e.md hang off the
    // right, and nothing has scrolled off the left yet.
    // By ROLE, not by label: both controls are always in the DOM so that they
    // can fade rather than blink, and the empty one is `aria-hidden`. A role
    // query respects that, which is the same question a user's eyes ask.
    expect(screen.getByRole('button', { name: '2 tabs off the right' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /off the left/ })).toBeNull()

    // Scroll two pills' worth: a.md and b.md are now behind you, and everything
    // else fits ahead.
    host.scrollLeft = 2 * PILL_WIDTH
    act(() => void fireEvent.scroll(host))

    expect(screen.getByRole('button', { name: '2 tabs off the left' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /off the right/ })).toBeNull()
  } finally {
    restore()
  }
})

test('a count that empties fades out instead of being ripped out of the row', () => {
  // The bug this pins: reaching the end of a scroll used to unmount the count
  // on a single frame, and because it sat in the flex row, removing it handed
  // ~24px back to the viewport and re-laid every pill out mid-scroll. It is now
  // out of the layout and always mounted, so what happens is a fade.
  const restore = withFakeLayout()
  try {
    const { host } = manyStrip()
    trackScroll(host)
    expect(screen.getByRole('button', { name: '2 tabs off the right' })).toBeInTheDocument()

    // Scroll to the far end: nothing is off the right any more.
    host.scrollLeft = 100
    act(() => void fireEvent.scroll(host))

    // Gone to the eye and to the accessibility tree...
    expect(screen.queryByRole('button', { name: /off the right/ })).toBeNull()
    // ...but still in the DOM, still saying what it said, so it has something to
    // fade *out*. A blank pill fading away reads as the same glitch.
    expect(document.querySelector('[aria-label="2 tabs off the right"]')).not.toBeNull()
  } finally {
    restore()
  }
})

test('picking a tab from an overflow menu selects it', async () => {
  const restore = withFakeLayout()
  try {
    const user = userEvent.setup()
    const { host, onSelect } = manyStrip()
    trackScroll(host)

    await user.click(screen.getByRole('button', { name: '2 tabs off the right' }))
    await user.click(await screen.findByRole('menuitem', { name: /e\.md/ }))

    // The last of five, by absolute index — the menu lists what is off the edge,
    // and its entries have to point at the tab they name.
    expect(onSelect).toHaveBeenCalledWith(4)
  } finally {
    restore()
  }
})

/* ── The reorder preview ─────────────────────────────────────────────────
 *
 * jsdom draws nothing, but it holds inline styles — and the preview IS an
 * inline transform, so what the pills would do is readable here even though how
 * it looks is not. The offsets themselves are `test/tab-reorder.test.ts`.
 * ───────────────────────────────────────────────────────────────────── */

/** A `dragover` at a chosen x, carrying a tab. */
function dragOverAt(host: HTMLElement, dataTransfer: FakeDataTransfer, x: number): void {
  const event = new Event('dragover', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  Object.defineProperty(event, 'clientX', { value: x })
  fireEvent(host, event)
}

/** Past the midpoint of the third pill: a drop there inserts before c.md. */
const OVER_THIRD_PILL = 130

const styleOf = (name: string) => (pillFor(name) as HTMLElement).style

test('dragging a pill inside the strip opens a hole instead of drawing a caret', () => {
  const restore = withFakeLayout()
  vi.useFakeTimers()
  try {
    const { host } = manyStrip()
    trackScroll(host)
    const dataTransfer = tabDrag()

    act(() => void fireEvent(pillFor('a.md')!, dragEvent('dragstart', dataTransfer)))
    act(() => void dragOverAt(host, dataTransfer, OVER_THIRD_PILL))

    // The hole says where it lands, so the line saying so is redundant.
    expect(screen.queryByTestId('tab-caret')).toBeNull()
    // a.md steps over b.md — one pill (60) plus the strip's gap (4) — and b.md
    // comes back by exactly what a.md vacated. Nothing past them moves.
    expect(styleOf('a.md').transform).toBe('translateX(64px)')
    expect(styleOf('b.md').transform).toBe('translateX(-64px)')
    expect(styleOf('c.md').transform).toBe('translateX(0px)')
    // And you can see which one you picked up.
    expect(pillFor('a.md')).toHaveClass('opacity-40')
  } finally {
    vi.useRealTimers()
    restore()
  }
})

test('a tab arriving from another pane still gets the caret', () => {
  // No `dragstart` here: this strip is not the source, so it has no slot to move
  // out of and no idea how wide the incoming pill will be. Nothing to open a
  // hole from.
  const restore = withFakeLayout()
  vi.useFakeTimers()
  try {
    const { host } = manyStrip()
    trackScroll(host)

    act(() => void dragOverAt(host, tabDrag(), OVER_THIRD_PILL))

    expect(screen.getByTestId('tab-caret')).toBeInTheDocument()
    expect(styleOf('a.md').transform).toBe('')
  } finally {
    vi.useRealTimers()
    restore()
  }
})

test('a drop takes the preview away WITH its transition, so the move is not replayed', () => {
  // The layout is about to become exactly what the preview was showing. A
  // transform that vanished while a transition was still declared would animate
  // back from it — the pill would jump a slot and glide home, which is the
  // snap the preview exists to remove.
  const restore = withFakeLayout()
  vi.useFakeTimers()
  try {
    const { host } = manyStrip()
    trackScroll(host)
    const dataTransfer = tabDrag()

    act(() => void fireEvent(pillFor('a.md')!, dragEvent('dragstart', dataTransfer)))
    act(() => void dragOverAt(host, dataTransfer, OVER_THIRD_PILL))
    act(() => void fireEvent(host, dragEvent('drop', dataTransfer)))

    expect(styleOf('a.md').transform).toBe('')
    expect(styleOf('a.md').transition).toBe('')
    expect(pillFor('a.md')).not.toHaveClass('opacity-40')
  } finally {
    vi.useRealTimers()
    restore()
  }
})

test('a drag that ends without a drop glides home instead of snapping', () => {
  // Zeros rather than nothing: the transition has to survive the clearing, or
  // the pills teleport back to rest.
  const restore = withFakeLayout()
  vi.useFakeTimers()
  try {
    const { host } = manyStrip()
    trackScroll(host)
    const dataTransfer = tabDrag()

    act(() => void fireEvent(pillFor('a.md')!, dragEvent('dragstart', dataTransfer)))
    act(() => void dragOverAt(host, dataTransfer, OVER_THIRD_PILL))
    act(() => void fireEvent.dragLeave(host, { relatedTarget: document.body }))

    expect(styleOf('a.md').transform).toBe('translateX(0px)')
    expect(styleOf('a.md').transition).toContain('transform')
    expect(pillFor('a.md')).not.toHaveClass('opacity-40')
  } finally {
    vi.useRealTimers()
    restore()
  }
})

test('the strip reports crossings only, not every dragover', () => {
  // The workspace hides the panes' landing strips while a drag is over a tab
  // strip (a reorder has no business lighting up the pane below). `dragover`
  // fires continuously, so "still here" must not reach it sixty times a second
  // — every pane would re-render for an answer that had not changed.
  const restore = withFakeLayout()
  vi.useFakeTimers()
  try {
    const onDragOverStrip = vi.fn()
    render(
      <TabStrip
        tabs={manyTabs}
        active={0}
        onSelect={() => {}}
        onPin={() => {}}
        onClose={() => {}}
        onDropTab={vi.fn()}
        onDragOverStrip={onDragOverStrip}
      />,
    )
    const host = screen.getByTestId('tab-strip')
    trackScroll(host)
    const dataTransfer = tabDrag()

    act(() => void dragOverAt(host, dataTransfer, 10))
    act(() => void dragOverAt(host, dataTransfer, 20))
    expect(onDragOverStrip.mock.calls).toEqual([[true]])

    act(() => void fireEvent.dragLeave(host, { relatedTarget: document.body }))
    expect(onDragOverStrip.mock.calls).toEqual([[true], [false]])
  } finally {
    vi.useRealTimers()
    restore()
  }
})
