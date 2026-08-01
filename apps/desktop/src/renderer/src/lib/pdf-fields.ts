import type { TemplateField } from '@holi/shared'

/**
 * Which required fields the user still has to fill. A checkbox is never
 * "missing" — false is a legitimate value — so it's excluded even when required.
 * Everything else counts as blank when it trims to empty. Pure so the block can
 * validate without owning the rule (and so it can be unit-tested directly).
 */
export function missingRequired(
  fields: TemplateField[],
  values: Record<string, string>,
): TemplateField[] {
  return fields.filter(
    (f) => f.required && f.type !== 'checkbox' && (values[f.key] ?? '').trim() === '',
  )
}

/** Collapse the widget values into the `meta` map the render mutation expects —
 *  every declared field present, absent ones defaulted to ''. */
export function metaFromValues(
  fields: TemplateField[],
  values: Record<string, string>,
): Record<string, string> {
  const meta: Record<string, string> = {}
  for (const f of fields) meta[f.key] = values[f.key] ?? ''
  return meta
}
