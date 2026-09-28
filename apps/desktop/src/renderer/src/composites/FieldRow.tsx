/**
 * A label on the left, its control on the right, wrapping when it must.
 *
 * shadcn's horizontal `Field`, with a real `<label htmlFor>`: pressing the
 * label does what the platform does, so a text control takes the caret and a
 * button control (a date picker, a select) is clicked open. The control gets
 * its id from `useFieldControlId`, or from `children` as a function when it is
 * a bare primitive.
 *
 * `SettingRow`'s wrapping rule: a wrap container with a real label `basis`, so
 * a control drops to its own line exactly when it stops fitting. `basis-24`
 * because a frontmatter key is one word.
 */
import { createContext, useContext, useId } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Field, FieldLabel, IconButton, Tooltip } from '@/primitives'

const ControlId = createContext<string | undefined>(undefined)

/** The id the enclosing `FieldRow`'s label points at; undefined outside one. */
export function useFieldControlId(): string | undefined {
  return useContext(ControlId)
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
   * Deletes the entry, from an × that shows under the pointer. It floats just
   * past the row's end rather than taking a column, so a row with one and a
   * row without keep their controls in the same place.
   */
  onRemove?: () => void
  children: React.ReactNode | ((id: string) => React.ReactNode)
}): React.JSX.Element {
  const id = useId()
  return (
    <ControlId.Provider value={id}>
      <Field
        orientation="horizontal"
        className={cn(
          'relative flex-wrap items-start gap-x-3 gap-y-1 rounded-md px-1 py-0.5',
          // The label a fixed column. Set from here: `Field` sizes its label
          // with a parent selector, which outranks the label's own classes.
          '[&>[data-slot=field-label]]:shrink-0 [&>[data-slot=field-label]]:grow-0 [&>[data-slot=field-label]]:basis-24',
          hover && 'motion-respond hover:bg-muted/40',
        )}
      >
        <Tooltip content={title ?? label}>
          <FieldLabel
            htmlFor={id}
            // `h-8`, a control's height, so a control that grows (tags) keeps
            // its title on its first line.
            className="block h-8 min-w-0 truncate text-xs leading-8 font-normal text-muted-foreground"
          >
            {label}
          </FieldLabel>
        </Tooltip>
        {/* The control column grows, the label does not, so every control gets
            one width and they read as a column. `min-w-32` is the floor below
            which the control wraps to its own line. */}
        <div className="flex min-w-32 flex-1 items-center justify-end gap-1">
          {typeof children === 'function' ? children(id) : children}
        </div>
        {onRemove && (
          <IconButton
            icon={X}
            label={`remove field ${label}`}
            tooltip={`Remove ${label}`}
            // A child of the row, so pointing at it keeps the row hovered
            // even though it sits outside the row's box.
            className="absolute top-1/2 left-full -translate-y-1/2 opacity-0 group-hover/field:opacity-100 focus-visible:opacity-100"
            onClick={onRemove}
          />
        )}
      </Field>
    </ControlId.Provider>
  )
}
