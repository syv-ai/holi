"use client"
// ReUI: @reui/event-calendar (`npx shadcn@latest view @reui/event-calendar` shows the published source)

import {
  useEffect,
  useRef,
  type ComponentType,
  type HTMLAttributes,
  type ReactNode,
} from "react"
import {
  useEventCalendar,
  useEventCalendarSelector,
  useEventCalendarViewConfig,
} from "@/components/ui/event-calendar/event-calendar"
import { EventCalendarAgendaView } from "@/components/ui/event-calendar/event-calendar-agenda-view"
import { EventCalendarMonthView } from "@/components/ui/event-calendar/event-calendar-month-view"
import { EventCalendarResourceView } from "@/components/ui/event-calendar/event-calendar-resource-view"
import {
  EventCalendarDaysView,
  EventCalendarDayView,
  EventCalendarWeekView,
} from "@/components/ui/event-calendar/event-calendar-time-grid"
import type { CalendarView } from "@/components/ui/event-calendar/event-calendar-types"
import { Slot } from "radix-ui"

import { cn } from "@/lib/cn"

const DEFAULT_VIEW_COMPONENTS: Record<CalendarView, ComponentType> = {
  month: EventCalendarMonthView,
  week: EventCalendarWeekView,
  day: EventCalendarDayView,
  days: EventCalendarDaysView,
  agenda: EventCalendarAgendaView,
  resource: EventCalendarResourceView,
}

/** Horizontal wheel travel (px) a swipe needs before it pages. */
const SWIPE_THRESHOLD = 50
/** A quiet gap (ms) that ends a swipe. A trackpad's momentum keeps sending
 *  wheel events until it settles, so one swipe is one burst of them. */
const SWIPE_IDLE_MS = 180

interface SwipeState {
  /** Horizontal travel so far in this swipe. */
  travel: number
  /** This swipe already paged; the rest of it is swallowed. */
  paged: boolean
  /** timeStamp of the swipe's last event. */
  last: number
}

const SWIPE_START: SwipeState = { travel: 0, paged: false, last: -Infinity }

type SwipeWheel = Pick<
  WheelEvent,
  "deltaX" | "deltaY" | "deltaMode" | "shiftKey" | "timeStamp"
>

/** A wheel event's horizontal travel in px: a sideways trackpad swipe, or a
 *  shift-scroll (which some platforms already turn sideways). 0 for a
 *  vertical scroll, which stays the grid's. */
function horizontalTravel(event: SwipeWheel): number {
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
  if (event.shiftKey) return (event.deltaX || event.deltaY) * scale
  // Clearly sideways only: a vertical scroll drifts a little sideways too.
  return Math.abs(event.deltaX) > 2 * Math.abs(event.deltaY)
    ? event.deltaX * scale
    : 0
}

/**
 * One wheel event of a swipe: whether it pages (1 forward, -1 back, 0 not)
 * and whether the calendar claims it. A swipe pages once, when its travel
 * passes the threshold, and swallows the rest of its burst, so one gesture
 * is one period however long its momentum runs.
 */
function readSwipe(
  state: SwipeState,
  event: SwipeWheel
): { state: SwipeState; page: -1 | 0 | 1; claim: boolean } {
  const current =
    event.timeStamp - state.last > SWIPE_IDLE_MS ? SWIPE_START : state
  const travel = horizontalTravel(event)
  if (travel === 0) {
    // A paged swipe's momentum can drift vertical and still belongs to it;
    // before it pages, a vertical scroll means it was never a swipe.
    return {
      state: current.paged ? { ...current, last: event.timeStamp } : SWIPE_START,
      page: 0,
      claim: false,
    }
  }
  if (current.paged) {
    return {
      state: { ...current, last: event.timeStamp },
      page: 0,
      claim: true,
    }
  }
  const total = current.travel + travel
  const page = Math.abs(total) >= SWIPE_THRESHOLD ? (total > 0 ? 1 : -1) : 0
  return {
    state: { travel: total, paged: page !== 0, last: event.timeStamp },
    page,
    claim: true,
  }
}

/** Whether something between the target and the calendar's root scrolls
 *  sideways in this direction itself (a narrow week's columns), which then
 *  keeps the wheel. */
function innerScrollsX(
  target: EventTarget | null,
  root: HTMLElement,
  travel: number
): boolean {
  for (
    let el = target instanceof Element ? target : null;
    el && el !== root;
    el = el.parentElement
  ) {
    if (!(el instanceof HTMLElement) || el.scrollWidth <= el.clientWidth) {
      continue
    }
    const overflow = getComputedStyle(el).overflowX
    if (overflow !== "auto" && overflow !== "scroll") continue
    const room =
      travel > 0
        ? el.scrollWidth - el.clientWidth - el.scrollLeft
        : el.scrollLeft
    if (room > 1) return true
  }
  return false
}

const SWIPE_CLASSES = ["motion-in-from-end", "motion-in-from-start"] as const

interface EventCalendarContentProps extends HTMLAttributes<HTMLDivElement> {
  /** Swap individual view implementations. */
  components?: Partial<Record<CalendarView, ComponentType>>
  /** Replaces the switchboard entirely; read useEventCalendarView() inside. */
  children?: ReactNode
  asChild?: boolean
  /** A sideways trackpad swipe or a shift-scroll over the calendar pages one
   *  period in its direction, and the view slides in from that side. */
  swipeNavigation?: boolean
}

function EventCalendarContent({
  className,
  asChild = false,
  components,
  children,
  swipeNavigation = false,
  ...props
}: EventCalendarContentProps) {
  const instance = useEventCalendar()
  const contentRef = useRef<HTMLDivElement | null>(null)
  const viewConfig = useEventCalendarViewConfig()

  useEffect(() => {
    // Listen on the root: a loading view takes no pointer events, and the
    // next swipe must still land.
    const root = instance.internals.getRootEl()
    const el = contentRef.current
    if (!swipeNavigation || !root || !el) return
    let state = SWIPE_START
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return
      const travel = horizontalTravel(event)
      if (travel !== 0 && innerScrollsX(event.target, root, travel)) {
        // The swipe is the inner area's: when it reaches its edge, the rest
        // of the gesture's momentum is swallowed rather than paging.
        state = { travel: 0, paged: true, last: event.timeStamp }
        return
      }
      const read = readSwipe(state, event)
      state = read.state
      if (read.claim) event.preventDefault()
      if (read.page === 0) return
      if (read.page > 0) instance.api.next()
      else instance.api.prev()
      el.classList.remove(...SWIPE_CLASSES)
      // A reflow between remove and add restarts the slide when a swipe
      // lands mid-way through the last one.
      void el.offsetWidth
      el.classList.add(SWIPE_CLASSES[read.page > 0 ? 0 : 1])
    }
    // The slide's transform must not outlive it: it would make the view a
    // containing block for anything fixed inside.
    const onEnd = (event: AnimationEvent) => {
      if (event.target === el) el.classList.remove(...SWIPE_CLASSES)
    }
    root.addEventListener("wheel", onWheel, { passive: false })
    el.addEventListener("animationend", onEnd)
    return () => {
      root.removeEventListener("wheel", onWheel)
      el.removeEventListener("animationend", onEnd)
    }
  }, [instance, swipeNavigation])

  const view = useEventCalendarSelector((state) => state.view)
  const loading = useEventCalendarSelector((state) => state.loading)

  const resolved = {
    ...DEFAULT_VIEW_COMPONENTS,
    ...viewConfig.components,
    ...components,
  }
  // A spread copies keys that hold `undefined`, so `components={{ month: isPro
  // ? ProMonth : undefined }}` would erase the default and render <undefined />.
  const ActiveView = resolved[view] ?? DEFAULT_VIEW_COMPONENTS[view]

  const Comp = asChild ? Slot.Root : "div"

  return (
    <Comp
      ref={contentRef}
      data-slot="event-calendar-content"
      data-view={view}
      data-loading={loading || undefined}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col",
        "data-loading:pointer-events-none data-loading:opacity-60",
        viewConfig.classNames?.content,
        className
      )}
      {...props}
    >
      {children ?? <ActiveView />}
    </Comp>
  )
}

export { DEFAULT_VIEW_COMPONENTS, EventCalendarContent }
export type { EventCalendarContentProps }
