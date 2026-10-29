"use client"

import type { CSSProperties } from "react"
import { cn } from "@/lib/cn"
import type { SeparatorProps } from "motion-panels/react"
import { Separator } from "motion-panels/react"

const SEPARATOR =
  "relative flex items-center justify-center outline-hidden after:absolute after:bg-border after:transition-colors after:content-[''] focus-visible:ring-[3px] focus-visible:ring-ring/50 hover:after:bg-muted-foreground aria-[orientation=horizontal]:h-3 aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:h-px aria-[orientation=vertical]:w-3 aria-[orientation=vertical]:after:inset-y-0 aria-[orientation=vertical]:after:w-px data-crossing:after:bg-muted-foreground data-resizing:after:bg-ring [&[aria-orientation=horizontal]>div]:rotate-90"

const HANDLE =
  "z-10 flex h-4 w-3 items-center justify-center rounded-xs border bg-border"

const Grip = () => (
  <svg
    aria-hidden="true"
    className="text-muted-foreground size-2.5"
    fill="currentColor"
    viewBox="0 0 10 10"
  >
    <circle cx="4" cy="2" r="0.75" />
    <circle cx="4" cy="5" r="0.75" />
    <circle cx="4" cy="8" r="0.75" />
    <circle cx="7" cy="2" r="0.75" />
    <circle cx="7" cy="5" r="0.75" />
    <circle cx="7" cy="8" r="0.75" />
  </svg>
)

/** The `line` variant: the platform's 1px border line, which reaches 4px
 *  either side for the pointer and brightens on hover and while dragging. */
const LINE =
  "relative z-10 w-px shrink-0 cursor-col-resize bg-border outline-hidden after:absolute after:inset-y-0 after:-inset-x-1 hover:bg-ring focus-visible:bg-ring data-crossing:bg-ring data-resizing:bg-ring"

function PanelSeparator({
  className,
  withHandle,
  variant = "default",
  shift,
  landing = false,
  style,
  ...props
}: Omit<SeparatorProps, "children"> & {
  withHandle?: boolean
  variant?: "default" | "line"
  /** `line` only, while a drag opens a gap: how far the divider slides with
   *  its neighbours, or hidden where the gap opens. */
  shift?: number | "hidden"
  /** `line` only: a drop is landing, so nothing slides. */
  landing?: boolean
}) {
  const line = variant === "line"
  return (
    <Separator
      data-slot="panel-separator"
      style={
        line && typeof shift === "number"
          ? ({ ...style, "--sep-shift": `${shift}px` } as CSSProperties)
          : style
      }
      className={cn(
        line ? LINE : SEPARATOR,
        line && shift === "hidden" && "opacity-0",
        line && typeof shift === "number" && "translate-x-(--sep-shift)",
        line &&
          (landing
            ? "transition-none"
            : "motion-slide motion-reduce:transition-none"),
        className
      )}
      {...props}
    >
      {withHandle ? (
        <div className={HANDLE}>
          <Grip />
        </div>
      ) : null}
    </Separator>
  )
}

export { Group as PanelGroup, Panel } from "motion-panels/react"
export { PanelSeparator }
