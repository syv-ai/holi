import { cn } from "@/lib/cn"
import * as ResizablePrimitive from "react-resizable-panels"

function ResizablePanelGroup({
  className,
  animateFirst = false,
  ...props
}: ResizablePrimitive.GroupProps & {
  /** Slide the first panel's width when it changes, except while its divider is dragged. */
  animateFirst?: boolean
}) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        animateFirst &&
          "[&>[data-panel]:first-child]:motion-resize has-[[data-separator=active]]:[&>[data-panel]:first-child]:transition-none",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  variant = "default",
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
  /** `primary` is a wider hit area whose line turns primary on hover and drag. */
  variant?: "default" | "primary"
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-px items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        variant === "primary" &&
          "relative z-10 cursor-col-resize motion-respond after:w-3 hover:bg-primary data-[separator=active]:bg-primary data-[separator=hover]:bg-primary hover:[&>div]:bg-primary [&[data-separator=active]>div]:bg-primary [&[data-separator=hover]>div]:bg-primary [&>div]:motion-respond",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
