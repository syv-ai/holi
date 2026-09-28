/**
 * A control that is only an icon: the one place that decides how a clickable
 * icon looks and behaves (`docs/ui-system.md`, Icons).
 *
 * - **At rest** the icon is muted (`text-icon`), on no surface.
 * - **Under the pointer** it brightens to `text-icon-active`, takes the neutral
 *   `accent` background and grows a little (`scale-110`). A press settles it
 *   back (`active:scale-95`). All of it is `motion-respond`, so leaving reverses.
 * - **Pressed** (`pressed`, a toggle that is on), **active** (`active`, the
 *   current destination) and **open** (a menu trigger, Radix's
 *   `data-state=open`) all look like the hover, and stay.
 * - **Focus** is the one ring, `ring-1 ring-ring`; state never draws an edge.
 * - **The label** is both the accessible name and the tooltip, so there is no
 *   route to a native `title`. `tooltip` replaces the tooltip's content (a
 *   hotkey beside the name) or, `false`, drops it where the holder shows one.
 *
 * `className` is for layout and reveal (`opacity-0 group-hover:opacity-100`);
 * the lint gate rejects colour, background and hover classes on it, because
 * those are this file's.
 */
import { forwardRef, type ComponentProps, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Icon, type IconGlyph } from './Icon'
import { Tooltip } from './Tooltip'

const BOX = { sm: 'size-6', md: 'size-8' } as const

/** A state the glyph itself carries, at rest and under the pointer alike. */
export type IconTone = 'busy' | 'warn' | 'alert' | 'live'
/** `busy` is the brand, `warn` amber (no token yet; a named utility is
 *  gate-legal), `alert` destructive, `live` the green of a running session. */
export const ICON_TONE: Record<IconTone, string> = {
  busy: 'text-brand',
  warn: 'text-amber-400',
  alert: 'text-destructive',
  live: 'text-green-500',
}
/** A loop on the glyph, bound to a state that is in flight (`index.css`). */
export type IconMotion = 'orbit' | 'pulse'
export const ICON_MOTION: Record<IconMotion, string> = {
  orbit: 'motion-orbit',
  pulse: 'motion-pulse',
}

export type IconButtonProps = Omit<ComponentProps<'button'>, 'children' | 'aria-label'> & {
  icon: IconGlyph
  /** The accessible name, and the tooltip unless `tooltip` says otherwise. */
  label: string
  /** `sm`: a 24px box around a 14px icon, for dense rows and headers.
   *  `md`: a 32px box around a 16px icon, for toolbars and the dock. */
  size?: 'sm' | 'md'
  shape?: 'square' | 'round'
  /** A toggle's state: `aria-pressed`, and the hover look while on. */
  pressed?: boolean
  /** The current destination: the hover look, without `aria-pressed`. The
   *  holder sets `aria-current` where it means something. */
  active?: boolean
  /** Fill the glyph as well as stroke it: a starred item's star. */
  filled?: boolean
  /** The glyph's colour for a state (`ICON_TONE`); absent, the muted rest. */
  tone?: IconTone
  /** The glyph loops while its state is in flight (`ICON_MOTION`). */
  motion?: IconMotion
  /** Hover and open change the icon's colour only: no tint behind it, no
   *  grow. For a control inside something that already has a hover look (a
   *  card's ⋯). */
  quiet?: boolean
  tooltip?: ReactNode | false
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  /** Drawn over the icon: a badge on its corner. */
  children?: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    label,
    size = 'sm',
    shape = 'square',
    pressed,
    active = false,
    filled = false,
    tone,
    motion,
    quiet = false,
    tooltip,
    tooltipSide,
    className,
    children,
    type = 'button',
    ...props
  },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      data-slot="icon-button"
      data-active={active ? '' : undefined}
      className={cn(
        'relative inline-flex shrink-0 cursor-default items-center justify-center text-icon outline-none motion-respond',
        quiet
          ? 'hover:text-icon-active data-[state=open]:text-icon-active'
          : [
              'hover:scale-110 hover:bg-accent hover:text-icon-active active:scale-95',
              'aria-pressed:bg-accent aria-pressed:text-icon-active data-active:bg-accent data-active:text-icon-active data-[state=open]:bg-accent data-[state=open]:text-icon-active',
            ],
        'focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
        BOX[size],
        shape === 'round' ? 'rounded-full' : 'rounded-md',
        className,
      )}
      {...props}
    >
      <Icon
        icon={icon}
        size={size}
        filled={filled}
        className={cn(tone && ICON_TONE[tone], motion && ICON_MOTION[motion])}
      />
      {children}
    </button>
  )
  if (tooltip === false) return button
  return (
    <Tooltip content={tooltip ?? label} side={tooltipSide}>
      {button}
    </Tooltip>
  )
})
