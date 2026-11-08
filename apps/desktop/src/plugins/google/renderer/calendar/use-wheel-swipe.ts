/**
 * Swipe paging for the event calendar: a sideways trackpad swipe or a
 * shift-scroll over it pages one period in its direction, and the view slides
 * in from that side (`motion-in-from-end`, `motion-in-from-start`).
 *
 * Built on the calendar's own API (`useEventCalendar()`: `api.next`,
 * `api.prev` and the root element), so the stock ReUI files stay as installed.
 * Call it from a component inside `<EventCalendar>`.
 */
import { useEffect } from 'react'
import { useEventCalendar } from '@/components/ui/event-calendar/event-calendar'

/** Horizontal wheel travel (px) a swipe needs before it pages. */
const SWIPE_THRESHOLD = 50
/** A quiet gap (ms) that ends a swipe. A trackpad's momentum keeps sending
 *  wheel events until it settles, so one swipe is one burst of them. The gap
 *  is timed from when the last event was handled, not from its timestamp:
 *  paging re-renders the calendar, and the events that queue up behind that
 *  render must not read as a new swipe. */
const SWIPE_IDLE_MS = 180

interface SwipeState {
  /** Horizontal travel so far in this swipe. */
  travel: number
  /** This swipe already paged; the rest of it is swallowed. */
  paged: boolean
}

const SWIPE_START: SwipeState = { travel: 0, paged: false }

type SwipeWheel = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'shiftKey'>

/** A wheel event's horizontal travel in px: a sideways trackpad swipe, or a
 *  shift-scroll (which some platforms already turn sideways). 0 for a
 *  vertical scroll, which stays the grid's. */
function horizontalTravel(event: SwipeWheel): number {
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
  if (event.shiftKey) return (event.deltaX || event.deltaY) * scale
  // Clearly sideways only: a vertical scroll drifts a little sideways too.
  return Math.abs(event.deltaX) > 2 * Math.abs(event.deltaY) ? event.deltaX * scale : 0
}

/**
 * One wheel event of a swipe: whether it pages (1 forward, -1 back, 0 not)
 * and whether the calendar claims it. A swipe pages once, when its travel
 * passes the threshold, and swallows the rest of its burst, so one gesture
 * is one period however long its momentum runs.
 */
function readSwipe(
  state: SwipeState,
  event: SwipeWheel,
): { state: SwipeState; page: -1 | 0 | 1; claim: boolean } {
  const travel = horizontalTravel(event)
  if (travel === 0) {
    // A paged swipe's momentum can drift vertical and still belongs to it;
    // before it pages, a vertical scroll means it was never a swipe.
    return { state: state.paged ? state : SWIPE_START, page: 0, claim: false }
  }
  if (state.paged) return { state, page: 0, claim: true }
  const total = state.travel + travel
  const page = Math.abs(total) >= SWIPE_THRESHOLD ? (total > 0 ? 1 : -1) : 0
  return { state: { travel: total, paged: page !== 0 }, page, claim: true }
}

/** Whether something between the target and the calendar's root scrolls
 *  sideways in this direction itself (a narrow week's columns), which then
 *  keeps the wheel. */
function innerScrollsX(target: EventTarget | null, root: HTMLElement, travel: number): boolean {
  for (
    let el = target instanceof Element ? target : null;
    el && el !== root;
    el = el.parentElement
  ) {
    if (!(el instanceof HTMLElement) || el.scrollWidth <= el.clientWidth) continue
    const overflow = getComputedStyle(el).overflowX
    if (overflow !== 'auto' && overflow !== 'scroll') continue
    const room = travel > 0 ? el.scrollWidth - el.clientWidth - el.scrollLeft : el.scrollLeft
    if (room > 1) return true
  }
  return false
}

const SWIPE_CLASSES = ['motion-in-from-end', 'motion-in-from-start'] as const

/** The view the slide plays on: the calendar's content, found under its root. */
const CONTENT = '[data-slot="event-calendar-content"]'

export function useWheelSwipe(): void {
  const instance = useEventCalendar()

  useEffect(() => {
    // Listen on the root: a loading view takes no pointer events, and the
    // next swipe must still land.
    const root = instance.internals.getRootEl()
    if (!root) return
    let state = SWIPE_START
    let idle: ReturnType<typeof setTimeout> | undefined
    /** End the swipe after a quiet gap. A timer that fires well late means the
     *  thread was busy (a page's render), and wheel events may be queued
     *  behind it: wait one more gap rather than ending the swipe under them. */
    const endAfterQuiet = () => {
      clearTimeout(idle)
      const armed = performance.now()
      idle = setTimeout(() => {
        if (performance.now() - armed > 2 * SWIPE_IDLE_MS) endAfterQuiet()
        else state = SWIPE_START
      }, SWIPE_IDLE_MS)
    }
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return
      const travel = horizontalTravel(event)
      if (travel !== 0 && innerScrollsX(event.target, root, travel)) {
        // The swipe is the inner area's: when it reaches its edge, the rest
        // of the gesture's momentum is swallowed rather than paging.
        state = { travel: 0, paged: true }
        endAfterQuiet()
        return
      }
      const read = readSwipe(state, event)
      state = read.state
      if (state === SWIPE_START) clearTimeout(idle)
      else endAfterQuiet()
      if (read.claim) event.preventDefault()
      if (read.page === 0) return
      if (read.page > 0) instance.api.next()
      else instance.api.prev()
      const content = root.querySelector<HTMLElement>(CONTENT)
      if (!content) return
      content.classList.remove(...SWIPE_CLASSES)
      // A reflow between remove and add restarts the slide when a swipe
      // lands mid-way through the last one.
      void content.offsetWidth
      content.classList.add(SWIPE_CLASSES[read.page > 0 ? 0 : 1])
    }
    // The slide's transform must not outlive it: it would make the view a
    // containing block for anything fixed inside.
    const onEnd = (event: AnimationEvent) => {
      const el = event.target
      if (el instanceof HTMLElement && el.matches(CONTENT)) el.classList.remove(...SWIPE_CLASSES)
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    root.addEventListener('animationend', onEnd)
    return () => {
      clearTimeout(idle)
      root.removeEventListener('wheel', onWheel)
      root.removeEventListener('animationend', onEnd)
    }
  }, [instance])
}
