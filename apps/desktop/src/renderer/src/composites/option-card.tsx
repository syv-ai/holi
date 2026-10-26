import type { ReactNode } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/cn'
import { IconTile } from '@/components/reui/icon-tile'

/**
 * One option among several, as a card you tick (after ReUI's `settings-1`):
 * its mark on an `IconTile`, its name with an optional badge, a sentence on
 * what it is, and a checkbox in the corner. The whole card is the label, so a
 * press anywhere on it toggles; the checkbox is the one control, and carries
 * the name for a screen reader.
 *
 * A ticked card lifts its fill a step, and only its fill: state is a
 * background, never an edge or a ring (`docs/ui-system.md`, Rules), and in a
 * grid of them the ticked ones should read as "in", not as "selected right
 * now". A card that cannot change (`disabled`) dims and says
 * why in `note`.
 *
 * Lay them in a grid (`grid gap-3 sm:grid-cols-2`); each sizes to its row.
 */
export function OptionCard({
  mark,
  title,
  badge,
  description,
  note,
  checked,
  disabled = false,
  onCheckedChange,
  className,
  ...rest
}: {
  mark: ReactNode
  title: string
  badge?: ReactNode
  description?: ReactNode
  /** A line under the description: why it cannot change, or what off means. */
  note?: ReactNode
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
  className?: string
} & Omit<React.ComponentProps<'label'>, 'children' | 'title' | 'onChange'>): React.JSX.Element {
  return (
    <Label
      data-disabled={disabled || undefined}
      className={cn(
        'cursor-pointer leading-normal font-normal data-disabled:cursor-not-allowed',
        className,
      )}
      {...rest}
    >
      <Card
        data-checked={checked || undefined}
        className="relative w-full bg-card/40 hover:bg-card/70 data-checked:bg-card/90"
      >
        <CardContent>
          <div className={cn('flex flex-col gap-3', disabled && 'opacity-60')}>
            <Checkbox
              className="absolute end-3 top-3"
              checked={checked}
              disabled={disabled}
              onCheckedChange={(next) => onCheckedChange(next === true)}
              aria-label={title}
            />
            <IconTile>{mark}</IconTile>
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{title}</span>
                {badge}
              </div>
              {description !== undefined && (
                <p className="text-sm text-pretty text-muted-foreground">{description}</p>
              )}
              {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
            </div>
          </div>
        </CardContent>
      </Card>
    </Label>
  )
}
