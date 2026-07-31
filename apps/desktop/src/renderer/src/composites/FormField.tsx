/**
 * A labelled field: caption on top, the control (a primitive) as children, and
 * the error bundled *into* the field — today that error line is an ad-hoc
 * `text-red-400` scattered beside inputs. Generalises TaskDetail's `Row`, lifted
 * out of the tasks feature so both features consume it downward.
 */
export function FormField({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted-fg">{label}</span>
      {children}
      {error !== undefined && <span className="mt-1 block text-xs text-danger">{error}</span>}
    </label>
  )
}
