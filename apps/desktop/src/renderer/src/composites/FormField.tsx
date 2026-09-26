/**
 * A labelled field: caption on top, the control (a primitive) as children, and
 * the error line bundled into the field.
 */
export function FormField({
  label,
  required,
  error,
  children,
}: {
  label: string
  /** Appends the ` *` required marker to the caption — one home for the convention. */
  required?: boolean
  error?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted-foreground">
        {label}
        {required === true && <span className="text-destructive"> *</span>}
      </span>
      {children}
      {error !== undefined && <span className="mt-1 block text-xs text-destructive">{error}</span>}
    </label>
  )
}
