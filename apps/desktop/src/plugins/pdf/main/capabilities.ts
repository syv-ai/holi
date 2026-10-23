/**
 * PDF's capabilities. The agent reads a marked-up PDF's comments, renders a
 * note and finds Typst at the CLI door; the plugin's own renderer lists
 * templates, renders a note and keeps the viewer's signatures at the UI door.
 * Both doors render through one entry, so the agent's PDFs and Convert to
 * PDF's come out the same, diagrams included.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isMachineStatePath, isSecretPath, localDate, vaultRelPath } from '@holi/shared'
import { resolveRelative } from '@holi/shared/path-safety-node'
import {
  cap,
  CapabilityError,
  noParams,
  optionalStringParam,
  paramsObject,
  pathParams,
  stringParam,
  type CapabilityTable,
} from '../../../main/plugin-api'
import { commentThreadsJson, formatCommentThreads } from '../shared/pdf-comments'
import { missingRequired, parseFrontmatter, prefillValues } from '../shared/pdf-fields'
import { pdfCommentsInVault } from './comments'
import type { DrawDiagrams } from './mermaid'
import { renderPdf } from './render'
import type { SignatureStore } from './signatures'
import { listTemplates } from './templates'

/** A comment's JSON timestamps back into the dates its formatter reads. */
function dated<C extends { created: string | null; modified: string | null }>(c: C) {
  const date = (iso: string | null) => (iso === null ? null : new Date(iso))
  return { ...c, created: date(c.created), modified: date(c.modified) }
}

export const PDF_NAMESPACES = ['pdf'] as const

export interface PdfCapabilityDeps {
  /** The viewer's saved signatures, in `userData`. */
  signatures: SignatureStore
  /** The Typst binary, downloaded on first use (`sharedTypst`); null when it
   *  cannot be had. */
  typst(): Promise<string | null>
  /** Draws a note's mermaid diagrams for its PDF (`mermaid-window.ts`). */
  diagrams: DrawDiagrams
}

/** A size the way a person reads it. */
function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The render params. `out` is where the PDF goes: absolute, or relative to
 *  the vault; absent, it goes beside the note. Only an absolute `out` may
 *  leave the vault. The template defaults to
 *  `plain`. Field values come as `meta` from the dialog and as the remaining
 *  params from the CLI (`--recipient Acme`). */
function renderParams(raw: unknown): {
  path: string
  template: string
  out?: string
  meta: Record<string, string>
} {
  const { path, template, out, meta, ...fields } = paramsObject(raw)
  const p = { path, template, out }
  const outPath = optionalStringParam(p, 'out')
  return {
    path: stringParam(p, 'path'),
    template: optionalStringParam(p, 'template') ?? 'plain',
    ...(outPath === undefined ? {} : { out: outPath }),
    meta: { ...metaOf(meta), ...metaOf(fields) },
  }
}

/** A flat string-to-string map. Any other value is refused rather than
 *  reaching `typst`. */
function metaOf(m: unknown): Record<string, string> {
  if (m === undefined || m === null) return {}
  if (typeof m !== 'object' || Array.isArray(m)) {
    throw new CapabilityError('BAD_REQUEST', 'meta must be an object')
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new CapabilityError('BAD_REQUEST', `meta value for ${k} must be a string`)
    }
    out[k] = v
  }
  return out
}

/** `abs` as a vault path when it is inside the vault at `root`, else null. */
function vaultPathOf(root: string, abs: string): string | null {
  const rel = relative(root, abs)
  if (!rel || rel.startsWith('..') || rel === abs) return null
  try {
    return vaultRelPath(rel.split(sep).join('/'))
  } catch {
    return null
  }
}

/** `rel` inside the vault at `root`, symlinks resolved, or BAD_REQUEST. */
async function inVault(root: string, rel: string): Promise<string> {
  try {
    return await resolveRelative(root, rel)
  } catch (err) {
    throw new CapabilityError('BAD_REQUEST', `${rel}: ${(err as Error).message}`)
  }
}

/** Refuse a secret or machine-state vault path: a PDF must neither carry a
 *  secret out into a file that gets committed, nor land among this machine's
 *  state. Checked on the path as given and as resolved, so a symlink cannot
 *  dress one up as the other. */
function refusePrivate(rels: (string | null)[]): void {
  for (const rel of rels) {
    if (rel !== null && (isSecretPath(rel) || isMachineStatePath(rel))) {
      throw new CapabilityError('BAD_REQUEST', `${rel} is a secret or machine-state path`)
    }
  }
}

/** Whether `abs` itself is a symlink (absent is not). */
async function isSymlink(abs: string): Promise<boolean> {
  return lstat(abs).then(
    (s) => s.isSymbolicLink(),
    () => false,
  )
}

export function pdfCapabilities(deps: PdfCapabilityDeps) {
  const typst = async (): Promise<string> => {
    const bin = await deps.typst()
    if (bin === null) throw new CapabilityError('UNAVAILABLE', 'typst is not available')
    return bin
  }

  return {
    // Its threads as the viewer shows them. The value is the `--json` shape, so
    // the text revives its dates.
    'pdf.comments': cap({
      doors: ['cli'],
      cli: {
        args: ['path'],
        summary: "a vault PDF's comments: page, mark, marked text, author, dates and replies",
      },
      params: pathParams,
      run: async (ctx, { path }) => {
        const result = await pdfCommentsInVault(ctx.root, path)
        if (!result.ok) throw new CapabilityError('BAD_REQUEST', result.error)
        return commentThreadsJson(result.path, result.threads)
      },
      text: ({ path, threads }) =>
        formatCommentThreads(
          path,
          threads.map((t) => ({ ...dated(t), replies: t.replies.map(dated) })),
        ),
    }),

    // The bundled Typst engine, downloaded on first use: the agent's
    // md-to-pdf skill compiles with the path this prints.
    'pdf.typst': cap({
      doors: ['cli'],
      cli: { args: [], summary: "the Typst binary's path, downloading it on first use" },
      params: noParams,
      run: async () => typst(),
      text: (bin) => bin,
    }),

    // The vault's templates, for the Convert picker and its metadata inputs.
    'pdf.templates': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx) =>
        (await listTemplates(ctx.root)).map(({ name, slug, description, fields, warnings }) => ({
          name,
          slug,
          description,
          fields,
          warnings,
        })),
    }),

    // Render `path` through `template` to a PDF and say where it went, how
    // big it is, and what did not come out as written. `vaultPath` is set when
    // the PDF is inside the vault, so the caller can open it in a tab; the
    // watcher picks the new file up. Fields fill as the dialog fills them: a
    // value given, else the note's frontmatter, else the field's default.
    'pdf.render': cap({
      doors: ['ui', 'cli'],
      cli: {
        args: ['path', 'template?'],
        summary:
          'render a note to a PDF through a template (default plain): [--out <path>], [--<field> <value>]',
      },
      params: renderParams,
      run: async (ctx, { path, template, out, meta }) => {
        // Canonicalised, so a symlink inside the vault cannot lead the read
        // out of it.
        const noteAbs = await inVault(ctx.root, path)
        const realRoot = await realpath(ctx.root)
        refusePrivate([vaultRelPath(path), vaultPathOf(realRoot, noteAbs)])
        const templates = await listTemplates(ctx.root)
        const tpl = templates.find((t) => t.slug === template)
        if (tpl === undefined) {
          const known = templates.map((t) => t.slug).join(', ')
          throw new CapabilityError('NOT_FOUND', `template ${template} (the vault has: ${known})`)
        }
        const unknown = Object.keys(meta).filter((k) => !tpl.fields.some((f) => f.key === k))
        if (unknown.length > 0) {
          const known = tpl.fields.map((f) => f.key).join(', ') || 'none'
          throw new CapabilityError(
            'BAD_REQUEST',
            `not a field of ${template}: ${unknown.join(', ')} (its fields: ${known})`,
          )
        }
        if (out !== undefined && !/\.pdf$/i.test(out)) {
          throw new CapabilityError('BAD_REQUEST', 'out must end in .pdf')
        }
        // Beside the note, or a vault path, resolved like the note so a
        // symlink cannot carry the write out of the vault. An absolute `out`
        // is the one way out, because it says so. A symlink already at the
        // destination is refused either way: the write would land wherever
        // it points.
        const outside = out !== undefined && isAbsolute(out)
        const pdfRel = out ?? path.replace(/\.(md|markdown)$/i, '') + '.pdf'
        const pdfPath = outside ? pdfRel : await inVault(ctx.root, pdfRel)
        refusePrivate([
          outside ? vaultPathOf(ctx.root, pdfPath) : vaultRelPath(pdfRel),
          vaultPathOf(realRoot, pdfPath),
        ])
        if (await isSymlink(outside ? pdfRel : join(ctx.root, vaultRelPath(pdfRel)))) {
          throw new CapabilityError('BAD_REQUEST', `${pdfRel} is a symlink`)
        }
        const note = await readFile(noteAbs, 'utf8').catch(() => null)
        if (note === null) throw new CapabilityError('NOT_FOUND', path)
        const values = {
          ...prefillValues(tpl.fields, parseFrontmatter(note), localDate(new Date())),
          ...meta,
        }
        const missing = missingRequired(tpl.fields, values)
        if (missing.length > 0) {
          throw new CapabilityError(
            'BAD_REQUEST',
            `${template} needs ${missing.map((f) => f.key).join(', ')}`,
          )
        }
        const typstBin = await typst()
        const { warnings } = await renderPdf({
          typstBin,
          templateDir: tpl.dir,
          ...(tpl.language === undefined ? {} : { language: tpl.language }),
          notePath: noteAbs,
          outPath: pdfPath,
          fields: tpl.fields,
          meta: values,
          diagrams: deps.diagrams,
        })
        const { size } = await stat(pdfPath)
        // The vault's path as given or as resolved: an absolute `out` may name
        // either.
        const vaultPath = vaultPathOf(ctx.root, pdfPath) ?? vaultPathOf(realRoot, pdfPath)
        return { pdfPath, vaultPath, bytes: size, warnings }
      },
      text: ({ pdfPath, vaultPath, bytes, warnings }) =>
        [`${vaultPath ?? pdfPath} (${sizeText(bytes)})`, ...warnings].join('\n'),
    }),

    // The signatures made in the viewer, as the library's serialized list.
    // Not vault-scoped: one list per machine and person, kept out of every
    // vault because a vault is a shared repo.
    'pdf.signatures': cap({
      doors: ['ui'],
      params: noParams,
      run: async () => deps.signatures.read(),
    }),

    'pdf.saveSignatures': cap({
      doors: ['ui'],
      params: (raw: unknown) => ({ entriesJson: stringParam(paramsObject(raw), 'entriesJson') }),
      run: async (_ctx, { entriesJson }) => {
        try {
          await deps.signatures.write(entriesJson)
        } catch (err) {
          throw new CapabilityError('BAD_REQUEST', (err as Error).message)
        }
        return { ok: true as const }
      },
    }),
  } satisfies CapabilityTable
}

export type PdfCapabilities = ReturnType<typeof pdfCapabilities>
