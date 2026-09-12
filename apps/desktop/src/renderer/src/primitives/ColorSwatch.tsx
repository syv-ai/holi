import * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * A colour, shown as it really is, that opens the system picker when pressed.
 *
 * **The swatch is painted with the raw CSS value, not with a converted hex.**
 * A theme token resolves to whatever it resolves to — `oklch(14.5% 0 0)` from
 * Tailwind's palette, or a `color-mix(...)` for the derived ones like
 * `--divider` — and converting that to `#rrggbb` to fill a square would be
 * reimplementing colour spaces to tell the browser something it already knows.
 * So `background` takes the value verbatim and the browser resolves it.
 *
 * **The native input underneath needs a hex, and only for its starting point.**
 * `<input type="color">` speaks `#rrggbb` and nothing else. It is stretched
 * invisibly over the swatch rather than hidden, because a hidden input cannot
 * be clicked to open the picker and driving one through a ref means a synthetic
 * click that Safari and Chromium disagree about.
 *
 * A primitive because it wraps a native `<input>`, which the renderer's gate
 * allows here and nowhere else.
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
