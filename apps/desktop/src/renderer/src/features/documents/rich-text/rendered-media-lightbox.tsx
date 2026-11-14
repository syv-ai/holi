import { useEditorActivity } from '@/hooks/use-editor-activity'
import { type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTrigger,
  DialogTitle,
} from '@/components/ui/dialog'

/** Shared read-only inspection surface for rendered media inside a note. */
export function RenderedMediaLightbox({
  title,
  children,
  preview,
  onTriggerClick,
  open,
  onOpenChange,
  restoreFocus,
}: {
  title: string
  children: ReactNode
  preview: ReactNode
  onTriggerClick?: React.MouseEventHandler<HTMLButtonElement>
  open?: boolean
  onOpenChange?: (open: boolean) => void
  restoreFocus?: () => void
}) {
  const activity = useEditorActivity()
  const controlled = open !== undefined
  const content = controlled ? (
    children
  ) : (
    <DialogTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="media"
        aria-label={`Open ${title}`}
        onClick={onTriggerClick}
      >
        {children}
      </Button>
    </DialogTrigger>
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {content}
      <DialogContent
        size="media"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          if (!controlled || !restoreFocus) return
          event.preventDefault()
          const current = activity.capture()
          queueMicrotask(() => {
            if (current()) restoreFocus()
          })
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-24 min-w-0 items-start justify-center overflow-auto">
          {preview}
        </div>
      </DialogContent>
    </Dialog>
  )
}
