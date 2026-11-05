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
}: {
  title: string
  children: ReactNode
  preview: ReactNode
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="media" aria-label={`Open ${title}`}>
          {children}
        </Button>
      </DialogTrigger>
      <DialogContent size="media" aria-describedby={undefined}>
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
