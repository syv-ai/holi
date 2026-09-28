/**
 * The morph for a popup that opens from a trigger: `Select` and `DropdownMenu`.
 * The same family as the nav menu (`MorphingMenu`) and the palette
 * (`CommandDialog`): their surface, their rows, their springs (`springs.ts`).
 *
 * **Out of the trigger.** The popup sits ON its trigger (a negative side
 * offset of the trigger's height), and its surface starts as the trigger's own
 * box, then springs out to the list from the trigger's corner while the rows
 * cascade in. Closing plays it backwards: the rows drop away, the surface
 * shrinks back into the trigger and fades. Flipped above (no room below), it
 * grows upward from the trigger's bottom corner instead.
 *
 * **The surface is its own layer.** The popup's element keeps the list's full
 * size from its first frame, so Radix's placement (flip, collision) measures
 * the real list once and never jumps mid-spring. What springs is an absolutely
 * placed layer behind the rows that paints the background and the shadow.
 * The rows need no clip: they arrive after the surface has made room, and
 * leave before it shrinks.
 *
 * **The exit is ours, not Radix's.** Radix unmounts on close unless told
 * `forceMount`, and waits only for CSS animations. `useMorphPopup` keeps the
 * content force-mounted from the open until its exit has played, then lets
 * Radix have it back (Radix's documented pattern for a JS animation library).
 */
import { useReducedMotion } from 'motion/react'
import { animate } from 'motion'
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { MOTION_STAGGER_CAP } from '@/lib/motion'
import { rowAt, rowArrive, rowFrom, rowGone, rowLeave, spring } from './springs'

type Morph = {
  open: boolean
  /** The trigger's element, for the size the surface grows from. */
  trigger: React.RefObject<HTMLElement | null>
}

const MorphContext = createContext<Morph | null>(null)

/**
 * The root half: owns `open` (controlled or not, as Radix's own root would)
 * and the trigger's element, and hands both to the content.
 */
export function useMorphRoot({
  open: controlled,
  defaultOpen,
  onOpenChange,
}: {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}): {
  open: boolean
  onOpenChange: (open: boolean) => void
  provide: (children: ReactNode) => React.JSX.Element
} {
  const [inner, setInner] = useState(defaultOpen ?? false)
  const open = controlled ?? inner
  const trigger = useRef<HTMLElement | null>(null)
  const change = useCallback(
    (next: boolean) => {
      if (controlled === undefined) setInner(next)
      onOpenChange?.(next)
    },
    [controlled, onOpenChange],
  )
  return {
    open,
    onOpenChange: change,
    provide: (children) => (
      <MorphContext.Provider value={{ open, trigger }}>{children}</MorphContext.Provider>
    ),
  }
}

/** The trigger half: `ref` composed with the one the content measures. */
export function useMorphTrigger<T extends HTMLElement>(ref?: React.Ref<T>): React.RefCallback<T> {
  const morph = useContext(MorphContext)
  const trigger = morph?.trigger
  return useCallback(
    (element: T | null) => {
      if (trigger) trigger.current = element
      if (typeof ref === 'function') ref(element)
      else if (ref) ref.current = element
    },
    [trigger, ref],
  )
}

/** Rows the cascade moves: the primitives mark their items, labels and
 *  separators with it. */
export const MORPH_ROW = 'data-morph-row'

/** The opening, in seconds: the surface shows at once over the trigger and
 *  springs out; the rows follow it in, one step behind each other. */
const appear = { duration: 0.06 } as const
const grow = { ...spring, duration: 0.36, bounce: 0.2 } as const
const ROWS_AFTER = 0.06
/** The closing, quicker than the opening, as the menu's is: the rows go,
 *  then the surface shrinks into the trigger and fades. Short, because Radix
 *  holds the page's pointer events until the popup unmounts. */
const shrink = { ...spring, duration: 0.18, bounce: 0, delay: 0.04 } as const
const vanish = { duration: 0.08, delay: 0.14 } as const

/**
 * The content half. `mounted` is what to pass as `forceMount`; `sideOffset`
 * lays the popup over its trigger; `contentRef` and `surfaceRef` go on the
 * popup's element and its surface layer.
 */
export function useMorphPopup(): {
  mounted: boolean
  sideOffset: number
  /** For the popup's `style`: its least width, the trigger's. */
  style: React.CSSProperties
  contentRef: React.RefCallback<HTMLDivElement>
  surfaceRef: React.RefObject<HTMLDivElement | null>
} {
  const morph = useContext(MorphContext)
  const open = morph?.open ?? false
  const reducedMotion = useReducedMotion() ?? false
  const [exiting, setExiting] = useState(false)
  /** The trigger's box as the popup opens: its height is the offset that
   *  lays the popup over it, its width the popup's least width. Set here, not
   *  from Radix's trigger-width variable, which arrives only once the popup
   *  is placed, after the morph has measured it. */
  const [anchor, setAnchor] = useState({ width: 0, height: 0 })
  const [seen, setSeen] = useState(open)
  /** State, not a ref: Radix's portal mounts the popup a commit after the
   *  open, and the morph must start when the element exists, not before. */
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  /** What the last effect run saw: an open that is not an arrival is a reopen
   *  mid-exit, which grows back from wherever the exit had got to. */
  const wasOpen = useRef(false)
  // Adjusted during render, not in an effect: the render that closes must
  // already keep the content mounted, or Radix drops it before the exit plays.
  // The offset is read as it opens, so it never moves under an open popup.
  if (open !== seen) {
    setSeen(open)
    if (open) {
      const trigger = morph?.trigger.current
      setAnchor({ width: trigger?.offsetWidth ?? 0, height: trigger?.offsetHeight ?? 0 })
    } else if (!reducedMotion) setExiting(true)
  }
  const mounted = open || exiting

  useLayoutEffect(() => {
    const surface = surfaceRef.current
    // Open, and the portal has not put the popup in the page yet.
    if (open && !content) return
    // Still exiting as it opens: a reopen, not an arrival.
    const arriving = open && !wasOpen.current && !exiting
    const leaving = !open && wasOpen.current
    wasOpen.current = open
    if (!content || !surface) {
      if (leaving) setExiting(false)
      return
    }
    const rows = [...content.querySelectorAll<HTMLElement>(`[${MORPH_ROW}]`)]
    const box = morph?.trigger.current?.getBoundingClientRect()
    const full = { width: content.offsetWidth, height: content.offsetHeight }
    const seed = {
      width: Math.min(box?.width ?? full.width, full.width),
      height: Math.min(box?.height ?? full.height, full.height),
    }
    const running: ReturnType<typeof animate>[] = []
    let cancelled = false
    const track = (animation: ReturnType<typeof animate>) => {
      running.push(animation)
      return animation
    }
    const when = (animations: ReturnType<typeof animate>[], then: () => void) =>
      void Promise.all(animations.map((animation) => animation.finished))
        .then(() => !cancelled && then())
        .catch(() => {}) // A stopped transition must never run its last step.
    // Settled, the surface follows the list as it changes (a filtered menu).
    const settle = () => Object.assign(surface.style, { width: '', height: '' })

    if (open) {
      setExiting(false)
      if (reducedMotion) {
        settle()
        content.style.opacity = ''
        rows.forEach((row) => Object.assign(row.style, { opacity: '', transform: '', filter: '' }))
      } else if (arriving) {
        Object.assign(surface.style, { width: `${seed.width}px`, height: `${seed.height}px` })
        content.style.opacity = '0'
        rows.forEach((row) => Object.assign(row.style, rowFrom))
        track(animate(content, { opacity: 1 }, appear))
        when([track(animate(surface, full, grow))], settle)
        rows.forEach((row, index) =>
          track(animate(row, rowAt, rowArrive(Math.min(index, MOTION_STAGGER_CAP), ROWS_AFTER))),
        )
      } else {
        track(animate(content, { opacity: 1 }, appear))
        when([track(animate(surface, full, { ...grow, bounce: 0.1 }))], settle)
        rows.forEach((row) => track(animate(row, rowAt, { ...spring, duration: 0.25 })))
      }
    } else if (leaving && !reducedMotion) {
      Object.assign(surface.style, {
        width: `${surface.offsetWidth}px`,
        height: `${surface.offsetHeight}px`,
      })
      rows.forEach((row) => track(animate(row, rowGone, rowLeave)))
      track(animate(surface, seed, shrink))
      when([track(animate(content, { opacity: 0 }, vanish))], () => setExiting(false))
    }
    return () => {
      cancelled = true
      running.forEach((animation) => animation.stop())
    }
    // Runs on the open flag and the popup's arrival only: a re-render with the
    // popup open must not replay the morph.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reducedMotion, content])

  return {
    mounted,
    sideOffset: -anchor.height,
    style: { minWidth: `max(8rem, ${anchor.width}px)` },
    contentRef: setContent,
    surfaceRef,
  }
}

/**
 * The surface layer: behind the rows, sized to the popup when settled, and
 * anchored at the corner the popup grows from. Radix writes `data-side` and
 * `data-align` on the popup; the `group/morph` on it is what these read.
 */
export const MORPH_SURFACE =
  'pointer-events-none absolute -z-10 h-full w-full rounded-[1.25rem] bg-popover shadow-popover ' +
  'top-0 left-0 group-data-[side=top]/morph:top-auto group-data-[side=top]/morph:bottom-0 ' +
  'group-data-[align=end]/morph:left-auto group-data-[align=end]/morph:right-0 ' +
  'group-data-[align=center]/morph:left-1/2 group-data-[align=center]/morph:-translate-x-1/2'

/** The popup element's own classes, shared by both primitives. */
export const MORPH_POPUP =
  'group/morph relative isolate z-50 text-sm text-popover-foreground outline-none data-[state=closed]:pointer-events-none'

/** A row's look, as the nav menu's list draws one. */
export const MORPH_ROW_LOOK =
  'relative flex min-h-8 w-full cursor-default items-center gap-2 rounded-xl px-2.5 py-1.5 text-sm outline-hidden select-none motion-respond focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50'
