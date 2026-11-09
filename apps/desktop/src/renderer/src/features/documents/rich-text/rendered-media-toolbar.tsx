import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'

/** Hover- and keyboard-reachable actions shared by rendered media node views. */
export function RenderedMediaToolbar({ children }: { children: ReactNode }) {
  return (
    <div
      role="toolbar"
      aria-label="Rendered media"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      className="absolute -top-10 right-0 z-10 flex items-center gap-1 rounded-md border bg-popover p-1 opacity-0 shadow-sm motion-respond group-hover/media:opacity-100 group-focus-within/media:opacity-100"
    >
      {children}
    </div>
  )
}

export function RenderedMediaAction(props: React.ComponentProps<typeof Button>) {
  return <Button type="button" variant="ghost" size="xs" {...props} />
}
