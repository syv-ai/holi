/**
 * A label on the left, its control on the right, wrapping when it must.
 *
 * `SettingRow`'s wrapping rule: a wrap container with a real label `basis`, so
 * a control drops to its own line exactly when it stops fitting. No breakpoint
 * or container query: a pane can be any width, and each row answers for
 * itself. `basis-24` because a frontmatter key is one word.
 */
import { cn } from '@/lib/cn'
import { Tooltip } from '@/primitives'

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

/** The same, for a value that is read rather than edited: no edge, no height of
 *  its own, but the same inset so it lines up with the fields above and below. */
export const FIELD_READONLY = 'truncate px-3 text-xs text-muted-foreground'

export function FieldRow({
  label,
  title,
  hover = false,
  children,
}: {
  label: string
  /** Tooltip text, when the label alone does not say enough. Defaults to it. */
  title?: string
  /** Tint the row under the pointer. Off by default: a row nested inside
   *  another (the recurrence field's) would tint twice. */
  hover?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-1 py-0.5',
        hover && 'motion-respond hover:bg-muted/40',
      )}
    >
      <Tooltip content={title ?? label}>
        <span className="min-w-0 shrink-0 basis-24 truncate text-xs text-muted-foreground">
          {label}
        </span>
      </Tooltip>
      {/* The control column grows, the label does not, so every control gets
          one width and they read as a column. `min-w-32` is the floor below
          which the control wraps to its own line. */}
      <div className="flex min-w-32 flex-1 items-center justify-end gap-1">{children}</div>
    </div>
  )
}
