import type { ReactNode } from 'react'
import { FramePanel, IconTile, Label } from '@/primitives'
import { cn } from '@/lib/cn'

/**
 * One setting or one option, as a panel of a stacked ReUI `Frame` (after
 * ReUI's `settings-1`): its mark on an `IconTile`, its name with an optional
 * badge, what it does, and its control at the end of the row. A control that
 * needs width, a choice of pills or a list of sub-switches, goes under the
 * text (`children`), aligned with it rather than with the tile.
 *
 * `pressable` makes the row a label, so a press anywhere on it toggles the
 * control (a checkbox or a switch); the control still carries the name for a
 * screen reader. A row that cannot change (`disabled`) dims and says why in
 * `note`.
 *
 * Stack them inside `<Frame stacked>`: the frame draws the one surface, the
 * rows share its borders.
 */
export function SettingCard({
  mark,
  title,
  badge,
  description,
  note,
  control,
  children,
  pressable = false,
  disabled = false,
  className,
  ...rest
}: {
  mark: ReactNode
  title: string
  badge?: ReactNode
  description?: ReactNode
  /** A line under the description: why it cannot change, or what off means. */
  note?: ReactNode
  /** At the end of the heading row: a switch or a checkbox. */
  control?: ReactNode
  /** Under the text: pills, a list. */
  children?: ReactNode
  pressable?: boolean
  disabled?: boolean
  className?: string
} & Omit<React.ComponentProps<'div'>, 'children' | 'title'>): React.JSX.Element {
  const row = (
    <>
      <IconTile aria-hidden="true">{mark}</IconTile>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-start gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{title}</span>
              {badge}
            </div>
            {description !== undefined && (
              <p className="text-sm text-pretty text-muted-foreground">{description}</p>
            )}
            {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
          </div>
          {control !== undefined && <div className="flex shrink-0 pt-0.5">{control}</div>}
        </div>
        {children}
      </div>
    </>
  )
  return (
    <FramePanel
      role="group"
      aria-label={title}
      data-disabled={disabled || undefined}
      className={cn('text-start data-disabled:opacity-60', className)}
      {...rest}
    >
      {pressable ? (
        <Label
          className={cn(
            'flex cursor-pointer items-start gap-4 leading-normal font-normal',
            disabled && 'cursor-not-allowed',
          )}
        >
          {row}
        </Label>
      ) : (
        <div className="flex items-start gap-4">{row}</div>
      )}
    </FramePanel>
  )
}
