/**
 * A label on the left, its control on the right, wrapping when it must.
 *
 * `SettingRow`'s wrapping rule: a wrap container with a real label `basis`, so
 * a control drops to its own line exactly when it stops fitting. No breakpoint
 * or container query: a pane can be any width, and each row answers for
 * itself. `basis-24` because a frontmatter key is one word.
 */
import type { MouseEvent } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button, Tooltip } from '@/primitives'

/**
 * What every control in a field row looks like: same height, type size, edge
 * and inset, so the answers read as one column. A constant rather than a
 * wrapper, because `Select`, `Button` and `Input` each need it on a different
 * element.
 */
export const FIELD_CONTROL =
  // `md:text-xs` too: the `Input` primitive's base carries `md:text-sm`, and a
  // responsive variant outranks an unprefixed override.
  'h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-xs font-normal md:text-xs ' +
  // No edge inside a note's frontmatter, the one place form fields go without
  // it: the row's hover tint says a value can be pressed. Scoped by where the
  // control is, not a prop, because the create-task dialog shares these
  // controls and keeps its edges.
  'in-data-frontmatter-fields:border-transparent'

/** A value that is not set: muted, consistently across every control. */
export const FIELD_UNSET = 'text-muted-foreground'

/**
 * A press anywhere on the row that missed its control focuses the control:
 * the text input first, so a tag chip's own remove button is never the pick.
 */
function focusControl(e: MouseEvent<HTMLDivElement>): void {
  const control = e.currentTarget.querySelector<HTMLElement>('[data-field-control]')
  if (control === null || control.contains(e.target as Node)) return
  e.stopPropagation() // a row nested in this one's control has already answered
  const target =
    control.querySelector<HTMLElement>('input:not([disabled])') ??
    control.querySelector<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')
  target?.focus()
}

export function FieldRow({
  label,
  title,
  hover = false,
  onRemove,
  children,
}: {
  label: string
  /** Tooltip text, when the label alone does not say enough. Defaults to it. */
  title?: string
  /** Tint the row under the pointer. Off by default: a row nested inside
   *  another (the recurrence field's) would tint twice. */
  hover?: boolean
  /**
   * Deletes the entry, from an × at the row's end that shows under the
   * pointer. `null` keeps the slot empty (nothing set to delete) so the
   * controls stay one column; leave it out for a row with no such slot.
   */
  onRemove?: (() => void) | null
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'group/field flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-1 py-0.5',
        hover && 'motion-respond hover:bg-muted/40',
      )}
      onClick={focusControl}
    >
      <Tooltip content={title ?? label}>
        <span className="min-w-0 shrink-0 basis-24 truncate text-xs text-muted-foreground">
          {label}
        </span>
      </Tooltip>
      {/* The control column grows, the label does not, so every control gets
          one width and they read as a column. `min-w-32` is the floor below
          which the control wraps to its own line. */}
      <div data-field-control="" className="flex min-w-32 flex-1 items-center justify-end gap-1">
        {children}
      </div>
      {onRemove === null && <span aria-hidden className="size-6 shrink-0" />}
      {onRemove && (
        <Tooltip content={`Remove ${label}`}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`remove field ${label}`}
            className="motion-respond shrink-0 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/field:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
          >
            <X />
          </Button>
        </Tooltip>
      )}
    </div>
  )
}
