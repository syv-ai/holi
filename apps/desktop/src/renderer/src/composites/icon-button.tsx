import type { ComponentProps, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeys } from './shortcut-keys'

/**
 * A stock `Button` that shows only a glyph, named by `label`: the label is its
 * accessible name and its tooltip, so an icon-only control is never silent.
 * Ghost and `icon-sm` by default; every other Button prop passes through.
 * Not a second button: the look is `components/ui/button`'s, this only adds
 * the tooltip every icon-only button needs.
 */
export function IconButton({
  label,
  tooltip,
  shortcut,
  tooltipSide,
  children,
  variant = 'ghost',
  size = 'icon-sm',
  ...props
}: ComponentProps<typeof Button> & {
  /** Accessible name and tooltip text. */
  label: string
  /** Tooltip content when it says more than the label (a label and its shortcut). */
  tooltip?: ReactNode
  /** Keys shown beside the label in the tooltip: `['mod', 'F']`. */
  shortcut?: readonly string[]
  tooltipSide?: ComponentProps<typeof TooltipContent>['side']
  /** The lucide glyph. */
  children: ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant={variant} size={size} aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>
        {tooltip ?? (
          <>
            {label}
            {shortcut ? <ShortcutKeys keys={shortcut} /> : null}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
