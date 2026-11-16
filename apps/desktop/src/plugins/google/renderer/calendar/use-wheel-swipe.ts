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
/** A quiet gap (ms) between input timestamps that ends a swipe. A trackpad's
 *  momentum keeps sending events until it settles. Their timestamps keep
 *  queued input in the same burst even when rendering delays its handling. */
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
 * and whether the calendar claims it. A swipe pages once, when its travel *  passes the threshold, and swallows the rest of its burst, so one gesture
 *  is one period however long its momentum runs. Gesture boundaries use wheel
 *  event timestamps, not a timer: a busy renderer may dispatch queued momentum
 *  after a timer has expired even though those events belong to the same burst.
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
    let lastEventTime: number | undefined
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return
      // WheelEvent.timeStamp is monotonic. Unlike a timer, it preserves the
      // order in which input was generated while the renderer was blocked.
      if (lastEventTime !== undefined && event.timeStamp - lastEventTime > SWIPE_IDLE_MS) {
        state = SWIPE_START
      }
      lastEventTime = event.timeStamp
      const travel = horizontalTravel(event)
      if (travel !== 0 && innerScrollsX(event.target, root, travel)) {
        // The swipe is the inner area's: when it reaches its edge, the rest
        // of the gesture's momentum is swallowed rather than paging.
        state = { travel: 0, paged: true }
        return
      }
      const read = readSwipe(state, event)
      state = read.state
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
      root.removeEventListener('wheel', onWheel)
      root.removeEventListener('animationend', onEnd)
    }
  }, [instance])
}
