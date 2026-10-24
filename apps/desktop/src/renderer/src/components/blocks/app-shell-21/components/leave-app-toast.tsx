import { useEffect, useRef, type CSSProperties } from "react"
import { toast } from "sonner"

export const LEAVE_TOAST_ID = "leave-app"

/**
 * The toast a first ⌘B in an app raises: what a second press does, and a line
 * round its edge that runs out when the chance to confirm does. Bottom right,
 * out of the way of the app's own toasts at the bottom centre.
 *
 * It never closes itself: Sonner pauses a toast's timer under the pointer,
 * which would leave the line and the window to confirm out of step, so the
 * shell dismisses it on its own clock.
 */
export function showLeaveAppToast(label: string, ms: number): void {
  toast.info(`Press ⌘B again to leave ${label}`, {
    id: LEAVE_TOAST_ID,
    position: "bottom-right",
    duration: Infinity,
    description: (
      <>
        ⌘B shows your vault's files and moves you out of {label}.
        <CountdownEdge ms={ms} />
      </>
    ),
  })
}

/** Inset by half the stroke, so the line sits on the toast's edge. */
const EDGE: CSSProperties = {
  x: 1,
  y: 1,
  width: "calc(100% - 2px)",
  height: "calc(100% - 2px)",
  rx: "var(--radius-lg)",
} as CSSProperties

/**
 * A primary line round the whole toast, unwinding linearly over `ms`. The
 * toast is Sonner's positioned `li` and nothing between it and the
 * description is, so `absolute inset-0` is the toast's own box. Under reduced
 * motion the line stays whole and the toast simply goes.
 */
function CountdownEdge({ ms }: { ms: number }) {
  const line = useRef<SVGRectElement>(null)
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const run = line.current?.animate(
      [{ strokeDashoffset: 0 }, { strokeDashoffset: -1 }],
      { duration: ms, easing: "linear", fill: "forwards" }
    )
    return () => run?.cancel()
  }, [ms])
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full overflow-visible"
    >
      <rect
        ref={line}
        style={EDGE}
        pathLength={1}
        strokeDasharray="1 1"
        className="stroke-primary fill-none"
        strokeWidth={2}
      />
    </svg>
  )
}
