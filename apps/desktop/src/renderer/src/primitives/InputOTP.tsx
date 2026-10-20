/**
 * shadcn's input-otp (radix-nova), vendored: a code typed or shown one
 * character per slot, on the `input-otp` package.
 *
 * Two changes from upstream, both the house rules (`docs/ui-system.md`): the
 * active slot recolours its own edge instead of growing a 3px halo, and it
 * responds through `motion-respond` rather than `transition-all`. The
 * separator's glyph goes through `Icon`.
 */
import * as React from 'react'
import { OTPInput, OTPInputContext } from 'input-otp'
import { Minus } from 'lucide-react'

import { cn } from '@/lib/cn'
import { Icon } from './Icon'

function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string
}) {
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={cn(
        'cn-input-otp flex items-center has-disabled:opacity-50',
        containerClassName,
      )}
      spellCheck={false}
      className={cn('disabled:cursor-not-allowed', className)}
      {...props}
    />
  )
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="input-otp-group"
      className={cn('flex items-center rounded-lg has-aria-invalid:border-destructive', className)}
      {...props}
    />
  )
}

function InputOTPSlot({
  index,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  index: number
}) {
  const inputOTPContext = React.useContext(OTPInputContext)
  const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {}

  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      className={cn(
        'relative flex size-8 items-center justify-center border-y border-r border-input text-sm motion-respond outline-none first:rounded-l-lg first:border-l last:rounded-r-lg aria-invalid:border-destructive data-[active=true]:z-10 data-[active=true]:border-ring data-[active=true]:aria-invalid:border-destructive dark:bg-input/30',
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-4 w-px bg-foreground motion-pulse" />
        </div>
      )}
    </div>
  )
}

function InputOTPSeparator({ ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="input-otp-separator"
      className="flex items-center text-muted-foreground"
      role="separator"
      {...props}
    >
      <Icon icon={Minus} size="sm" />
    </div>
  )
}

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator }
