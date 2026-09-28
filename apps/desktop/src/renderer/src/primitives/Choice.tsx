/**
 * Choosing inside a morphing surface (a dock's panel, quick add): the two
 * shapes a choice takes there, drawn as the nav menu draws its list.
 *
 * - `MorphRow`: a full-width row, `rounded-xl`, the accent background on
 *   hover and while `on`. Marked `data-morph-row`, so it cascades in with
 *   the panel.
 * - `PillGroup`: one choice among a few, as pills. The accent background
 *   slides from the old choice to the new one (a shared `layoutId`), so the
 *   change reads as movement, not as two repaints.
 *
 * State is background only; nothing here draws an edge.
 */
import { LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { Check } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Icon, type IconGlyph } from './Icon'
import { instant, settle } from './springs'

export function MorphRow({
  icon,
  label,
  value,
  on,
  onClick,
  className,
  ...rest
}: {
  icon?: IconGlyph
  label: ReactNode
  /** Shown at the row's end, muted: the current value of what it opens. */
  value?: ReactNode
  /** A toggle's state: the accent background and a check. */
  on?: boolean
  onClick?: () => void
  className?: string
} & Omit<React.ComponentProps<'button'>, 'onClick' | 'value'>): React.JSX.Element {
  return (
    <button
      type="button"
      data-morph-row=""
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'flex min-h-8 w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm outline-none motion-respond hover:bg-accent focus-visible:bg-accent aria-pressed:bg-accent',
        className,
      )}
      {...rest}
    >
      {icon && <Icon icon={icon} tone="muted" />}
      <span className="min-w-0 truncate">{label}</span>
      {value !== undefined && (
        <span className="ml-auto truncate text-muted-foreground">{value}</span>
      )}
      {on && <Icon icon={Check} className={value === undefined ? 'ml-auto' : ''} />}
    </button>
  )
}

export type PillOption<T extends string> = { value: T; label: ReactNode }

export function PillGroup<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  pillClassName,
}: {
  options: readonly PillOption<T>[]
  /** Nothing chosen is allowed: no pill carries the background. */
  value: T | undefined
  onChange: (value: T) => void
  /** The group's accessible name. */
  label: string
  className?: string
  pillClassName?: string
}): React.JSX.Element {
  const id = useId()
  const reduced = useReducedMotion() ?? false
  return (
    <LayoutGroup id={id}>
      <div role="radiogroup" aria-label={label} className={cn('flex flex-wrap gap-1', className)}>
        {options.map((option) => {
          const on = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={on}
              data-value={option.value}
              onClick={() => onChange(option.value)}
              className={cn(
                'relative h-7 shrink-0 rounded-xl px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring',
                pillClassName,
              )}
            >
              {on && (
                <motion.span
                  layoutId="pill"
                  transition={reduced ? instant : settle}
                  className="absolute inset-0 rounded-xl bg-accent"
                />
              )}
              <span className="relative">{option.label}</span>
            </button>
          )
        })}
      </div>
    </LayoutGroup>
  )
}
