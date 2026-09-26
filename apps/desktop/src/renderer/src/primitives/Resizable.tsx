import { GripVerticalIcon } from 'lucide-react'
import * as ResizablePrimitive from 'react-resizable-panels'
import { cn } from '@/lib/cn'

/**
 * Draggable split panels (shadcn's Resizable, on `react-resizable-panels`):
 * panels take a `defaultSize`/`minSize` and the neighbour absorbs the drag.
 * Used for split panes and the sidebar's sections.
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
 * A panel is a FLEX COLUMN, and that is load-bearing.
 *
 * The library renders a plain block with inline `overflow: auto`. A block
 * parent makes the content's `flex-1` inert, so content sizes to itself,
 * overflows, and the panel becomes a second scroll container around the
 * content's own (the tree then shifted sideways and its hover toolbar scrolled
 * away). As a flex column the content sizes to the panel and the inner
 * scroller does all the scrolling.
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
// Re-exported so features drive a collapsible panel without importing the
// library directly.
export type { PanelImperativeHandle } from 'react-resizable-panels'
