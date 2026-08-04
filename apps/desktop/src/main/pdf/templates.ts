import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFields, type TemplateField } from '@holi/shared'

export interface Template {
  /** Display name from the manifest. */
  name: string
  description: string
  fields: TemplateField[]
  /** What `parseFields` had to degrade in the manifest (empty = clean). Surfaced
   *  in the Convert dialog as authoring feedback. */
  warnings: string[]
  /** Absolute `.holi/document-templates/<slug>/`. */
  dir: string
  /** The directory name — the stable id passed to `pdf.render`. */
  slug: string
}

const TEMPLATES_REL = '.holi/document-templates'

/**
 * The vault's templates: subdirectories of `.holi/document-templates/` with a readable,
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
    const { fields, warnings } = parseFields(m.fields)
    templates.push({
      name: m.name,
      description: typeof m.description === 'string' ? m.description : '',
      fields,
      warnings,
      dir,
      slug: e.name,
    })
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name))
}
