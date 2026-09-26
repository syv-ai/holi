import * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * A colour, shown as it really is, that opens the system picker when pressed.
 *
 * The swatch paints the raw CSS value (`oklch(...)`, `color-mix(...)`) and
 * lets the browser resolve it. The native input needs a hex only for its
 * starting point; it is stretched invisibly over the swatch, because a hidden
 * input cannot be clicked and a synthetic click behaves differently across
 * engines. A primitive because it wraps a native `<input>`.
 */
export function ColorSwatch({
  /** What to paint: any CSS colour, usually `var(--some-token)`. */
  shown,
  /** Where the picker starts, as `#rrggbb`. */
  hex,
  onPick,
  label,
  className,
}: {
  shown: string
  hex: string
  onPick: (hex: string) => void
  label: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'motion-respond relative inline-block size-5 shrink-0 overflow-hidden rounded border border-border hover:border-ring',
        className,
      )}
      style={{ background: shown }}
    >
      <input
        type="color"
        value={hex}
        aria-label={label}
        onChange={(e) => onPick(e.target.value)}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
      />
    </span>
  )
}
