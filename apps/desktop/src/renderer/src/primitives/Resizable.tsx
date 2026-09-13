import { GripVerticalIcon } from 'lucide-react'
import * as ResizablePrimitive from 'react-resizable-panels'
import { cn } from '@/lib/cn'

/**
 * Draggable split panels (shadcn's Resizable, on `react-resizable-panels`). The
 * handle is a real drag-to-resize separator (not a collapse toggle); panels take
 * a `defaultSize`/`minSize` and the neighbour absorbs the drag. Holi uses one
 * horizontal group across the whole workspace row so the nav, editor and side
 * panels all resize against each other.
 */
function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps): React.JSX.Element {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn('flex h-full w-full aria-[orientation=vertical]:flex-col', className)}
      {...props}
    />
  )
}

/**
 * A panel is a FLEX COLUMN, and that is load-bearing rather than cosmetic.
 *
 * `react-resizable-panels` renders a plain block with `flex-grow: 1;
 * max-height: 100%; overflow: auto` inline. A block parent makes `flex-1` on the
 * child inert, so a child written as `flex min-h-0 flex-1 flex-col` — which is
 * how every panel's content in this app is written — sizes to its CONTENT
 * instead of to the panel, overflows, and the panel's own `overflow: auto`
 * quietly turns into a second scroll container wrapped around the one the
 * content already has.
 *
 * Measured in the running app: the file tree's content was 484px inside a 467px
 * panel, so the panel scrolled by 17px. That had two visible consequences,
 * neither of which looked like the same bug. The tree shifted sideways when that
 * outer scrollbar appeared, because the panel has no reserved gutter (the app's
 * `scrollbar-gutter: stable` rule is keyed to the `overflow-y-auto` utility, and
 * this element is styled inline by a library). And the explorer's hover toolbar
 * scrolled away, because it is absolutely positioned inside the content and the
 * thing scrolling was the panel around it, not the list it sits over.
 *
 * Making the panel a flex column gives the child a real main axis, so it sizes
 * to the panel and the inner scroller does all the scrolling. The library's
 * `overflow: auto` stays as the safety net it was meant to be.
 */
function ResizablePanel({ className, ...props }: ResizablePrimitive.PanelProps): React.JSX.Element {
  return (
    <ResizablePrimitive.Panel
      data-slot="resizable-panel"
      className={cn('flex min-h-0 min-w-0 flex-col', className)}
      {...props}
    />
  )
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & { withHandle?: boolean }): React.JSX.Element {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        'relative flex w-px items-center justify-center bg-divider after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90',
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-xs border bg-border">
          <GripVerticalIcon className="size-2.5" />
        </div>
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
// The imperative handle (collapse/expand/isCollapsed) — re-exported so features
// drive a collapsible panel without importing react-resizable-panels directly.
export type { PanelImperativeHandle } from 'react-resizable-panels'
