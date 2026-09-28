import * as React from 'react'

import { cn } from '@/lib/cn'
import { TEXT_FIELD_LOOK } from './field-look'

/** `bare` has no box of its own: the text-entry part of a surface that is
 *  something else (quick add's card), so the two never read as nested fields. */
function Textarea({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'textarea'> & { variant?: 'default' | 'bare' }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content w-full bg-transparent motion-respond outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'default' && `${TEXT_FIELD_LOOK} min-h-16 px-3 py-2 text-base md:text-sm`,
        variant === 'bare' && 'resize-none p-0',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
