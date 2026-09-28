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
        'flex min-h-8 w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm outline-none motion-respond hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring aria-pressed:bg-accent',
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

/**
 * Pills for one choice among a few, or several (`multiple`). A single
 * choice's accent background slides to the new pick. `active` marks the pill
 * a keyboard is on (the focus ring), for a group stepped by arrow keys from
 * outside; `tabbable={false}` keeps the pills out of the Tab order for the
 * same reason.
 */
export function PillGroup<T extends string>({
  options,
  isOn,
  onPick,
  active,
  label,
  multiple = false,
  tabbable = true,
  className,
}: {
  options: readonly PillOption<T>[]
  isOn: (value: T) => boolean
  onPick: (value: T) => void
  active?: T
  /** The group's accessible name. */
  label: string
  multiple?: boolean
  tabbable?: boolean
  className?: string
}): React.JSX.Element {
  const id = useId()
  const reduced = useReducedMotion() ?? false
  return (
    <LayoutGroup id={id}>
      <div
        role={multiple ? 'group' : 'radiogroup'}
        aria-label={label}
        className={cn('flex flex-wrap gap-1', className)}
      >
        {options.map((option) => {
          const on = isOn(option.value)
          return (
            <button
              key={option.value}
              type="button"
              role={multiple ? undefined : 'radio'}
              aria-checked={multiple ? undefined : on}
              aria-pressed={multiple ? on : undefined}
              data-value={option.value}
              data-active={active === option.value ? '' : undefined}
              tabIndex={tabbable ? undefined : -1}
              onClick={() => onPick(option.value)}
              className={cn(
                'relative h-7 shrink-0 rounded-xl px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring data-active:ring-1 data-active:ring-ring',
                multiple && on && 'bg-accent',
              )}
            >
              {on && !multiple && (
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

/**
 * A field of a draft, as a compact button in a row of them (quick add's
 * token bar): its icon and its value, muted until it is set, the accent
 * background while its choices are open.
 */
export function Token({
  icon,
  label,
  set,
  open,
  className,
  ...rest
}: {
  icon: IconGlyph
  label: ReactNode
  set: boolean
  open: boolean
} & React.ComponentProps<'button'>): React.JSX.Element {
  return (
    <button
      type="button"
      aria-expanded={open}
      data-set={set ? '' : undefined}
      className={cn(
        'flex h-7 max-w-48 items-center gap-1.5 rounded-xl px-2 text-xs outline-none motion-respond hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring aria-expanded:bg-accent',
        set ? 'text-foreground' : 'text-muted-foreground',
        className,
      )}
      {...rest}
    >
      <Icon icon={icon} size="sm" />
      <span className="truncate">{label}</span>
    </button>
  )
}
