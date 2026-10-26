import { BRAND_MONOGRAM, BRAND_WORDMARK } from '@/lib/brand-shapes'
import { cn } from '@/lib/cn'

/**
 * Holi's mark, drawn in `currentColor` so it follows the theme: the wordmark,
 * or the "h" alone. The paths are the files' in `apps/desktop/assets/`;
 * redraw them from those when the mark changes.
 */
export function BrandMark({
  variant = 'wordmark',
  size = 'md',
  className,
}: {
  variant?: 'wordmark' | 'monogram'
  /** `md` heads a screen; `lg` stands alone, as on the loading screen; `xl`
   *  is the New tab's. */
  size?: 'md' | 'lg' | 'xl'
  className?: string
}): React.JSX.Element {
  const shape = variant === 'monogram' ? BRAND_MONOGRAM : BRAND_WORDMARK
  return (
    <svg
      viewBox={`0 0 ${shape.width} ${shape.height}`}
      role="img"
      aria-label="Holi"
      fill="currentColor"
      className={cn('w-auto shrink-0', size === 'xl' ? 'h-24' : size === 'lg' ? 'h-16' : 'h-10', className)}
    >
      {shape.paths.map((d) => (
        <path key={d} d={d} fillRule={shape.fillRule} clipRule={shape.fillRule} />
      ))}
    </svg>
  )
}
