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
    <>
      <Dialog>
        <DialogTrigger asChild>
          <Button type="button" variant="ghost" aria-label={`Open ${title}`}>
            {children}
          </Button>
        </DialogTrigger>
        <DialogContent size="6xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="flex max-h-screen min-h-24 items-center justify-center overflow-auto">
            {preview}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
