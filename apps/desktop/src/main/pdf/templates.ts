import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TemplateField, TemplateFieldType } from '@holi/shared'

export interface Template {
  /** Display name from the manifest. */
  name: string
  description: string
  fields: TemplateField[]
  /** Absolute `.holi/templates/<slug>/`. */
  dir: string
  /** The directory name — the stable id passed to `pdf.render`. */
  slug: string
}

const TEMPLATES_REL = '.holi/templates'

/**
 * The vault's templates: subdirectories of `.holi/templates/` with a readable,
 * valid `template.json`. Missing dir → `[]`. A dir without a valid manifest is
 * skipped rather than throwing, so one bad template can't break Convert. Sorted
 * by display name.
 */
export async function listTemplates(vaultRoot: string): Promise<Template[]> {
  const base = join(vaultRoot, TEMPLATES_REL)
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  const templates: Template[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = join(base, e.name)
    const raw = await readFile(join(dir, 'template.json'), 'utf8').catch(() => null)
    if (raw === null) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const m = parsed as Record<string, unknown>
    if (typeof m.name !== 'string') continue
    templates.push({
      name: m.name,
      description: typeof m.description === 'string' ? m.description : '',
      fields: normalizeFields(m.fields),
      dir,
      slug: e.name,
    })
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name))
}

const FIELD_TYPES: readonly TemplateFieldType[] = [
  'text',
  'textarea',
  'date',
  'select',
  'number',
  'checkbox',
]

function normalizeFields(raw: unknown): TemplateField[] {
  if (!Array.isArray(raw)) return []
  const out: TemplateField[] = []
  for (const f of raw) {
    if (typeof f !== 'object' || f === null) continue
    const g = f as Record<string, unknown>
    if (typeof g.key !== 'string') continue
    let type: TemplateFieldType =
      typeof g.type === 'string' && (FIELD_TYPES as readonly string[]).includes(g.type)
        ? (g.type as TemplateFieldType)
        : 'text'
    const options =
      Array.isArray(g.options) && g.options.every((o) => typeof o === 'string')
        ? (g.options as string[])
        : undefined
    // A select needs options to render a dropdown; without them, degrade to a
    // text input rather than shipping an empty, unusable select.
    if (type === 'select' && (options === undefined || options.length === 0)) type = 'text'
    out.push({
      key: g.key,
      label: typeof g.label === 'string' ? g.label : g.key,
      type,
      required: g.required === true,
      ...(typeof g.default === 'string' ? { default: g.default } : {}),
      ...(type === 'select' && options !== undefined ? { options } : {}),
    })
  }
  return out
}
