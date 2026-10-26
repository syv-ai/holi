/**
 * The top row of a view in a tab: a document, a file, a session, the apps.
 * One height everywhere (56px) and one line that never wraps, so two views
 * side by side line up. It is a size container (`view-header`): what it
 * holds answers to the pane's width, not the window's, so a split narrows
 * it the way a small window would. Its parts give way in order, the meta
 * first, then labels, then secondary actions, and the title truncates last
 * (it keeps at least a short name's room).
 */
import type { ReactNode, Ref } from 'react'

import { cn } from '@/lib/cn'

export function ViewHeader({
  ref,
  className,
  children,
}: {
  ref?: Ref<HTMLElement>
  className?: string
  children: ReactNode
}) {
  return (
    <header
      ref={ref}
      className={cn(
        '@container/view-header flex h-14 shrink-0 items-center gap-3 border-b px-4 @2xl/view-header:px-6',
        className,
      )}
    >
      {children}
    </header>
  )
}

/** The title, with an optional badge beside it and one meta line under it
 *  (a folder, the save state), each truncating on its own line. */
export function ViewHeaderTitle({
  title,
  badge,
  meta,
}: {
  title: ReactNode
  badge?: ReactNode
  meta?: ReactNode
}) {
  return (
    <div className="flex min-w-20 flex-1 flex-col justify-center gap-px">
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="truncate text-sm font-medium">{title}</h1>
        {badge}
      </div>
      {meta === undefined ? null : (
        <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap">
          {meta}
        </div>
      )}
    </div>
  )
}
