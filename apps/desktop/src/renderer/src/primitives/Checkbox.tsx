import * as React from 'react'
import { CheckIcon } from 'lucide-react'
import { Checkbox as CheckboxPrimitive } from 'radix-ui'

import { cn } from '@/lib/cn'

/**
 * `shape="circle"` is for a TASK, not for a preference.
 *
 * A task's status is drawn as a circle everywhere else in the app — the file
 * tree's leaf glyph, the `@`-mention list, the orb on a wiki-link chip — so a
 * board card's completion control is a circle too. Everything that is genuinely
 * a checkbox (a setting, a filter, a PDF field) stays square, which is why this
 * is a variant rather than a new default.
 */
function Checkbox({
  className,
  shape = 'square',
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> & { shape?: 'square' | 'circle' }) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      data-shape={shape}
      className={cn(
        'peer size-4 shrink-0 border border-input shadow-xs motion-respond outline-none focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:bg-input/30 dark:data-[state=checked]:bg-primary',
        shape === 'circle' ? 'rounded-full' : 'rounded-[4px]',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
