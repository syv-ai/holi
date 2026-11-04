import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** An act's title and the sentence under it: the same two lines on every act,
 *  so moving through the ritual changes what is asked and not how it looks. */
export function ActHeading({
  title,
  description,
  center = false,
}: {
  title: ReactNode
  description?: ReactNode
  center?: boolean
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', center && 'items-center text-center')}>
      <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
      {description !== undefined && (
        <p className="max-w-lg text-sm text-pretty text-muted-foreground">{description}</p>
      )}
    </div>
  )
}
