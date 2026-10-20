/**
 * A label and its control as one group: shadcn's `field`, in its two
 * orientations, plus `FormField`, the one way the app lays a labelled control
 * out.
 *
 * - **Vertical** (a dialog's form): the caption above, the control under it,
 *   and the error line under that. The whole field is the `<label>`, so a
 *   press on the caption reaches the control without it needing an id.
 * - **Horizontal** (the frontmatter block, the recurrence rows): the caption
 *   a fixed column on the left, the control on the right, wrapping to its own
 *   line exactly when it stops fitting (a wrap container with a real label
 *   `basis`; `basis-24` because a frontmatter key is one word). The caption is
 *   a real `<label htmlFor>`, so pressing it does what the platform does: a
 *   text control takes the caret and a button control (a date picker, a
 *   select) is clicked open. The control gets its id from `useFieldControlId`,
 *   or from `children` as a function when it is a bare primitive.
 */
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { X } from 'lucide-react'

import { cn } from '@/lib/cn'
import { IconButton } from './IconButton'
import { Label } from './Label'
import { Tooltip } from './Tooltip'

const fieldVariants = cva('group/field flex w-full gap-3 data-[invalid=true]:text-destructive', {
  variants: {
    orientation: {
      vertical: ['flex-col [&>*]:w-full [&>.sr-only]:w-auto'],
      horizontal: ['flex-row items-center', '[&>[data-slot=field-label]]:flex-auto'],
    },
  },
  defaultVariants: {
    orientation: 'vertical',
  },
})

function Field({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof fieldVariants>) {
  return (
    <div
      role="group"
      data-slot="field"
      data-orientation={orientation}
      className={cn(fieldVariants({ orientation }), className)}
      {...props}
    />
  )
}

function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return (
    <Label
      data-slot="field-label"
      className={cn(
        'group/field-label peer/field-label flex w-fit gap-2 leading-snug group-data-[disabled=true]/field:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

function FieldError({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      role="alert"
      data-slot="field-error"
      className={cn('text-xs text-destructive', className)}
      {...props}
    />
  )
}

const ControlId = React.createContext<string | undefined>(undefined)

/** The id the enclosing horizontal `FormField`'s label points at; undefined
 *  outside one. */
function useFieldControlId(): string | undefined {
  return React.useContext(ControlId)
}

type FormFieldProps = {
  label: string
  /** Vertical (caption above) unless said otherwise. */
  orientation?: 'vertical' | 'horizontal'
  /** Appends the ` *` required marker to the caption: one home for the convention. */
  required?: boolean
  error?: string
  /** Horizontal: tooltip text, when the label alone does not say enough.
   *  Defaults to the label. */
  title?: string
  /** Horizontal: tint the row under the pointer. Off by default: a row nested
   *  inside another (the recurrence field's) would tint twice. */
  hover?: boolean
  /**
   * Horizontal: deletes the entry, from an × that shows under the pointer. It
   * floats just past the row's end rather than taking a column, so a row with
   * one and a row without keep their controls in the same place.
   */
  onRemove?: () => void
  children: React.ReactNode | ((id: string) => React.ReactNode)
}

function FormField({
  label,
  orientation = 'vertical',
  required,
  error,
  title,
  hover = false,
  onRemove,
  children,
}: FormFieldProps): React.JSX.Element {
  const id = React.useId()
  const control = typeof children === 'function' ? children(id) : children
  const caption = (
    <>
      {label}
      {required === true && <span className="text-destructive"> *</span>}
    </>
  )

  if (orientation === 'vertical') {
    return (
      <ControlId.Provider value={id}>
        {/* A plain `<label>`, not `FieldLabel`: it wraps the control, and
            the label's own type (`text-sm leading-none`) would reach it. */}
        <label data-slot="field" data-orientation="vertical" className="flex w-full flex-col gap-1">
          <span data-slot="field-label" className="text-xs text-muted-foreground">
            {caption}
          </span>
          {control}
          {error !== undefined && <FieldError>{error}</FieldError>}
        </label>
      </ControlId.Provider>
    )
  }

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
            {caption}
          </FieldLabel>
        </Tooltip>
        {/* The control column grows, the label does not, so every control gets
            one width and they read as a column. `min-w-32` is the floor below
            which the control wraps to its own line. */}
        <div className="flex min-w-32 flex-1 items-center justify-end gap-1">{control}</div>
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
        {error !== undefined && <FieldError className="basis-full">{error}</FieldError>}
      </Field>
    </ControlId.Provider>
  )
}

export { Field, FieldError, FieldLabel, FormField, useFieldControlId, type FormFieldProps }
