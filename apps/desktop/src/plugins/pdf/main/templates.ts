import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFields, type TemplateField } from '../shared/template-fields'
import { vaultRelPath } from '@holi/shared'
import { exactPath } from '@holi/shared/path-safety-node'
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface Template {
  /** Display name from the manifest. */
  name: string
  description: string
  fields: TemplateField[]
  /** The manifest's `language`, a language code such as `da` or `en`, passed
   *  to Typst as `--input lang=…`; absent, the template picks its own. */
  language?: string
  /** What `parseFields` had to degrade in the manifest (empty = clean). Surfaced
   *  in the Convert dialog as authoring feedback. */
  warnings: string[]
  /** Absolute `.holi/document-templates/<slug>/`. */
  dir: string
  /** The directory name — the stable id passed to `pdf.render`. */
  slug: string
}

/** A manifest's `language`: a two- or three-letter code, lowercased. Anything
 *  else is left out, with a warning for the Convert dialog. */
function parseLanguage(raw: unknown, warnings: string[]): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'string' && /^[a-z]{2,3}$/i.test(raw)) return raw.toLowerCase()
  warnings.push('"language" must be a language code such as "da" or "en", and was ignored')
  return undefined
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
    // Underscore-prefixed dirs are foundation, not templates (`_brand/` holds the
    // shared brand module + fonts + logo). It carries no manifest today, but guard
    // by name so it can never surface in the picker.
    if (e.name.startsWith('_')) continue
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
    const language = parseLanguage(m.language, warnings)
    if (m.name === 'Syv.ai report') continue
    templates.push({
      name: m.name,
      description: typeof m.description === 'string' ? m.description : '',
      fields,
      ...(language === undefined ? {} : { language }),
      warnings,
      dir,
      slug: e.name,
    })
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name))
}

/** Removes the retired named template and restores the supported seeded Report if
 * it occupied the canonical report slug. Every path is vault-relative and checked
 * for symlink components before access; the manifest is removed last. */
export async function migrateTemplates(
  root: string,
  seed: Record<string, string | Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  const base = '.holi/document-templates'
  const safe = async (rel: string) => {
    const valid = vaultRelPath(rel)
    const exact = await exactPath(root, valid)
    if (exact === null) throw new Error(`unsafe template migration path: ${rel}`)
    return exact
  }
  const check = () => {
    if (signal?.aborted) throw new Error('PDF template migration cancelled')
  }
  const entries = await readdir(await safe(base), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw new Error(`cannot inspect ${base}: ${error.message}`)
    },
  )
  let restoreReport = false
  for (const entry of entries) {
    check()
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    const dir = `${base}/${entry.name}`
    const manifest = `${dir}/template.json`
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(await safe(manifest), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError)
        continue
      throw new Error(`cannot read ${manifest}: ${String(error)}`)
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as Record<string, unknown>).name !== 'Syv.ai report'
    )
      continue
    if (entry.name === 'report') restoreReport = true
    const directory = await safe(dir)
    const removeContents = async (abs: string, rel: string): Promise<void> => {
      check()
      const st = await lstat(abs)
      if (st.isDirectory() && !st.isSymbolicLink()) {
        for (const child of await readdir(abs))
          await removeContents(`${abs}/${child}`, `${rel}/${child}`)
        if (rel !== manifest) await rm(abs)
      } else {
        if (rel !== manifest) await rm(abs)
      }
    }
    for (const child of await readdir(directory))
      if (child !== 'template.json')
        await removeContents(`${directory}/${child}`, `${dir}/${child}`)
    await rm(await safe(manifest))
    await rm(directory)
  }
  if (!restoreReport) return
  check()
  const prefix = `${base}/report/`
  const files = Object.entries(seed).filter(([path]) => path.startsWith(prefix))
  if (!files.some(([path]) => path === `${prefix}template.json`))
    throw new Error('seeded Report manifest is missing')
  // Exclusive creation ensures a concurrent/unexpected occupant is never overwritten.
  await mkdir(await safe(`${base}/report`), { recursive: false }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    },
  )
  for (const [rel, contents] of files.filter(([path]) => path !== `${prefix}template.json`)) {
    check()
    const destination = await safe(rel)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, contents, { flag: 'wx' })
  }
  check()
  const manifest = `${prefix}template.json`
  await writeFile(await safe(manifest), seed[manifest]!, { flag: 'wx' })
}
