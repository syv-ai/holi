/**
 * PDF's capabilities. The agent reads a marked-up PDF's comments and finds
 * Typst at the CLI door; the plugin's own renderer lists templates, renders a
 * note and keeps the viewer's signatures at the UI door.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { dirname, join, relative, sep } from 'node:path'
import { commentThreadsJson, formatCommentThreads, vaultRelPath } from '@holi/shared'
import {
  cap,
  CapabilityError,
  noParams,
  paramsObject,
  pathParams,
  stringParam,
  type CapabilityTable,
} from '../../../main/plugin-api'
import { pdfCommentsInVault } from './comments'
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
}

/** The render params. `outPath` is an absolute destination the native save
 *  dialog chose; absent, the PDF goes beside the note. `meta` maps the
 *  template's declared fields to the values typed for them. */
function renderParams(raw: unknown): {
  path: string
  template: string
  outPath?: string
  meta: Record<string, string>
} {
  const p = paramsObject(raw)
  const outPath = p.outPath
  if (outPath !== undefined && typeof outPath !== 'string') {
    throw new CapabilityError('BAD_REQUEST', 'outPath must be a string')
  }
  return {
    path: stringParam(p, 'path'),
    template: stringParam(p, 'template'),
    ...(outPath === undefined ? {} : { outPath }),
    meta: metaOf(p.meta),
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

    // Render `path` through `template` to a PDF and return where it went.
    // `vaultPath` is set when the PDF is inside the vault, so the caller can
    // open it in a tab; the watcher picks the new file up.
    'pdf.render': cap({
      doors: ['ui'],
      params: renderParams,
      run: async (ctx, { path, template, outPath, meta }) => {
        let noteAbs: string
        try {
          noteAbs = join(ctx.root, vaultRelPath(path))
        } catch (err) {
          throw new CapabilityError('BAD_REQUEST', (err as Error).message)
        }
        const tpl = (await listTemplates(ctx.root)).find((t) => t.slug === template)
        if (tpl === undefined) throw new CapabilityError('NOT_FOUND', `template ${template}`)
        const typstBin = await typst()
        const base = path
          .split('/')
          .at(-1)!
          .replace(/\.(md|markdown)$/i, '')
        const pdfPath = outPath ?? join(dirname(noteAbs), `${base}.pdf`)
        await renderPdf({
          typstBin,
          templateDir: tpl.dir,
          notePath: noteAbs,
          outPath: pdfPath,
          fields: tpl.fields,
          meta,
        })
        return { pdfPath, vaultPath: vaultPathOf(ctx.root, pdfPath) }
      },
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
