import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, link, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
const RESTORE_STATE = '.holi/state/pdf-report-restore.local.json'
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
  const publish = async (rel: string, bytes: Buffer): Promise<void> => {
    const tempRel = `.holi/state/pdf-template-${randomUUID()}.local.tmp`
    try {
      const tempPath = await safe(tempRel)
      check()
      await writeFile(tempPath, bytes, { flag: 'wx' })
      const temp = await safe(tempRel)
      const destination = await safe(rel)
      check()
      await link(temp, destination)
    } finally {
      // Clean up even on cancellation; only this invocation's random temp is removed.
      await unlink(await safe(tempRel)).catch(() => undefined)
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
  const reportDir = `${TEMPLATES_REL}/${REPORT_SLUG}`

  // The machine-local journal is created only after observing the retired Report
  // identity. A matching journal permits recovery only when the directory contains
  // a subset of exact seeded paths/bytes; it cannot bless custom occupants.
  let restoring = false
  try {
    const state = await readFile(await safe(RESTORE_STATE), 'utf8')
    if (state !== RESTORE_CONTENT) throw new Error('unexpected Report restoration state')
    restoring = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const removeTree = async (rel: string): Promise<void> => {
    check()
    vaultRelPath(rel)
    const parentRel = rel.slice(0, rel.lastIndexOf('/'))
    const leaf = rel.slice(rel.lastIndexOf('/') + 1)
    const parent = await safe(parentRel)
    const abs = join(parent, leaf)
    const st = await lstat(abs)
    if (st.isDirectory() && !st.isSymbolicLink()) {
      for (const child of await readdir(abs)) await removeTree(`${rel}/${child}`)
      check()
      // Re-check the parent immediately before the destructive operation.
      const currentParent = await safe(parentRel)
      check()
      await rmdir(join(currentParent, leaf))
    } else {
      // lstat does not follow a leaf symlink; unlink removes only the link.
      const currentParent = await safe(parentRel)
      check()
      await unlink(join(currentParent, leaf))
    }
  }
  for (const entry of entries) {
    check()
    if (!entry.isDirectory()) continue
    const dir = `${TEMPLATES_REL}/${entry.name}`
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(await safe(`${dir}/template.json`), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError)
        continue
      throw new Error(`cannot read ${dir}/template.json: ${String(error)}`)
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as Record<string, unknown>).name !== RETIRED_NAME
    )
      continue
    if (entry.name === REPORT_SLUG && seededFiles.length > 0 && !restoring) {
      const stateDir = await safe('.holi/state')
      check()
      await mkdir(stateDir, { recursive: true })
      await publish(RESTORE_STATE, Buffer.from(RESTORE_CONTENT))
      restoring = true
    }
    // Retired templates are intentionally removed as a whole, but only after
    // their identifying manifest has been validated above.
    const children = await readdir(await safe(dir))
    // Keep the identifying manifest until every other child has been removed. If
    // a deletion is interrupted, a retry can still prove this is the retired item.
    children.sort((a, b) => Number(a === 'template.json') - Number(b === 'template.json'))
    for (const child of children) await removeTree(`${dir}/${child}`)
    const retiredPath = await safe(dir)
    check()
    await rmdir(retiredPath)
  }

  if (!restoring || seededFiles.length === 0) return
  check()
  // Complete preflight before creating a directory or publishing any byte.
  const expected = new Map(seededFiles.map(([rel, contents]) => [rel, Buffer.from(contents)]))
  try {
    const actual = await readdir(await safe(reportDir))
    for (const name of actual) {
      const rel = `${reportDir}/${name}`
      if (!expected.has(rel)) throw new Error(`unexpected occupant at ${rel}`)
    }
    for (const [rel, bytes] of expected) {
      try {
        const st = await lstat(await safe(rel))
        if (!st.isFile() || st.isSymbolicLink() || !(await readFile(await safe(rel))).equals(bytes))
          throw new Error(`unexpected occupant at ${rel}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const reportPath = await safe(reportDir)
  check()
  await mkdir(reportPath, { recursive: true })
  for (const [rel, bytes] of seededFiles.filter(([path]) => path !== reportManifest)) {
    check()
    try {
      await readFile(await safe(rel))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await publish(rel, Buffer.from(bytes))
    }
  }
  check()
  try {
    await readFile(await safe(reportManifest))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await publish(reportManifest, Buffer.from(seed[reportManifest]!))
  }
  const statePath = await safe(RESTORE_STATE)
  check()
  await unlink(statePath)
}
