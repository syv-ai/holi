import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, link, rmdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseFields, type TemplateField } from '../shared/template-fields'
import { vaultRelPath } from '@holi/shared'
import { exactPath } from '@holi/shared/path-safety-node'

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

function parseLanguage(raw: unknown, warnings: string[]): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'string' && /^[a-z]{2,3}$/i.test(raw)) return raw.toLowerCase()
  warnings.push('"language" must be a language code such as "da" or "en", and was ignored')
  return undefined
}

const TEMPLATES_REL = '.holi/document-templates'
const REPORT_SLUG = 'report'
const RETIRED_NAME = 'Syv.ai report'
const RESTORE_STATE = `${TEMPLATES_REL}/_report-restore.json`
const RESTORE_CONTENT = '{"migration":"canonical-report-v1"}\n'

export async function listTemplates(vaultRoot: string): Promise<Template[]> {
  const base = join(vaultRoot, TEMPLATES_REL)
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  const templates: Template[] = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_')) continue
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
    if (typeof m.name !== 'string' || m.name === RETIRED_NAME) continue
    const { fields, warnings } = parseFields(m.fields)
    const language = parseLanguage(m.language, warnings)
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

/** Removes exact-name retired templates and restores the canonical seeded Report
 * after its retirement. The exclusive state file records ownership across crashes;
 * seeded files publish without replacing occupants, and the manifest publishes last. */
export async function migrateTemplates(
  root: string,
  seed: Record<string, string | Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  const safe = async (rel: string) => {
    const valid = vaultRelPath(rel)
    const exact = await exactPath(root, valid)
    if (exact === null) throw new Error(`unsafe template migration path: ${rel}`)
    return exact
  }
  const check = () => {
    if (signal?.aborted) throw new Error('PDF template migration cancelled')
  }
  const ensureRestoreState = async () => {
    const state = await safe(RESTORE_STATE)
    try {
      if ((await readFile(state, 'utf8')) !== RESTORE_CONTENT)
        throw new Error('unexpected Report restoration state')
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const tempRel = `${RESTORE_STATE}.${randomUUID()}.tmp`
    const temp = await safe(tempRel)
    try {
      check()
      await writeFile(temp, RESTORE_CONTENT, { flag: 'wx' })
      const exactTemp = await safe(tempRel)
      const exactState = await safe(RESTORE_STATE)
      check()
      await link(exactTemp, exactState).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
        if ((await readFile(await safe(RESTORE_STATE), 'utf8')) !== RESTORE_CONTENT)
          throw new Error('unexpected Report restoration state')
      })
    } finally {
      if (!signal?.aborted) await unlink(await safe(tempRel)).catch(() => undefined)
    }
  }
  const seededFiles = Object.entries(seed).filter(([path]) =>
    path.startsWith(`${TEMPLATES_REL}/${REPORT_SLUG}/`),
  )
  const reportManifest = `${TEMPLATES_REL}/${REPORT_SLUG}/template.json`
  if (seededFiles.length && !seededFiles.some(([path]) => path === reportManifest))
    throw new Error('seeded Report manifest is missing')

  const entries = await readdir(await safe(TEMPLATES_REL), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw new Error(`cannot inspect ${TEMPLATES_REL}: ${error.message}`)
    },
  )
  let restoreReport = false
  for (const entry of entries) {
    check()
    if (!entry.isDirectory()) continue
    const dir = `${TEMPLATES_REL}/${entry.name}`
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
      (parsed as Record<string, unknown>).name !== RETIRED_NAME
    )
      continue
    if (entry.name === REPORT_SLUG) {
      restoreReport = true
      check()
      await ensureRestoreState()
    }
    const removeTree = async (rel: string): Promise<void> => {
      check()
      const parent = await safe(dirname(rel))
      const abs = join(parent, basename(rel))
      check()
      const st = await lstat(abs)
      if (st.isDirectory() && !st.isSymbolicLink()) {
        const children = await readdir(abs)
        for (const child of children) await removeTree(`${rel}/${child}`)
        const exact = await safe(rel)
        check()
        await rmdir(exact)
      } else {
        check()
        await unlink(abs)
      }
    }
    const directory = await safe(dir)
    const children = await readdir(directory)
    for (const child of children) {
      if (child === 'template.json') continue
      await removeTree(`${dir}/${child}`)
    }
    const exactManifest = await safe(manifest)
    check()
    await unlink(exactManifest)
    const exactDirectory = await safe(dir)
    check()
    await rmdir(exactDirectory)
  }
  if (!restoreReport && seededFiles.length) {
    try {
      const state = await readFile(await safe(RESTORE_STATE), 'utf8')
      restoreReport = state === RESTORE_CONTENT
      if (!restoreReport) throw new Error('unexpected Report restoration state')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (!restoreReport || !seededFiles.length) return

  check()
  await ensureRestoreState()

  for (const [rel, contents] of seededFiles.filter(([path]) => path !== reportManifest)) {
    check()
    const destination = await safe(rel)
    const parent = dirname(destination)
    check()
    await mkdir(parent, { recursive: true }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
      const st = await lstat(parent)
      if (!st.isDirectory() || st.isSymbolicLink()) throw error
    })
    check()
    const bytes = Buffer.from(contents)
    try {
      const existing = await readFile(await safe(rel))
      if (!existing.equals(bytes)) throw new Error(`unexpected occupant at ${rel}`)
      continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    check()
    const tempRel = `${rel}.${randomUUID()}.tmp`
    const temp = await safe(tempRel)
    try {
      check()
      await writeFile(temp, bytes, { flag: 'wx' })
      const exactTemp = await safe(tempRel)
      const exactDestination = await safe(rel)
      check()
      await link(exactTemp, exactDestination)
    } finally {
      if (!signal?.aborted) await unlink(await safe(tempRel)).catch(() => undefined)
    }
  }
  check()
  const manifestContent = Buffer.from(seed[reportManifest]!)
  try {
    const existing = await readFile(await safe(reportManifest))
    if (!existing.equals(manifestContent))
      throw new Error(`unexpected occupant at ${reportManifest}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    check()
    const directory = await safe(`${TEMPLATES_REL}/${REPORT_SLUG}`)
    check()
    await mkdir(directory, { recursive: false }).catch((mkdirError: NodeJS.ErrnoException) => {
      if (mkdirError.code !== 'EEXIST') throw mkdirError
    })
    check()
    const tempRel = `${reportManifest}.${randomUUID()}.tmp`
    const temp = await safe(tempRel)
    try {
      check()
      await writeFile(temp, manifestContent, { flag: 'wx' })
      const exactTemp = await safe(tempRel)
      const exactManifest = await safe(reportManifest)
      check()
      await link(exactTemp, exactManifest)
    } finally {
      if (!signal?.aborted) await unlink(await safe(tempRel)).catch(() => undefined)
    }
  }
}
