/**
 * A PDF's comment threads, read from the file on disk (D106), for
 * `holi pdf comments`.
 *
 * **Through PDFium, the parser the viewer already uses**, running in Node: the
 * same `@embedpdf/pdfium` wasm and the same `PdfiumNative` engine the renderer
 * drives. A PDF saved by Holi keeps its comments as plain strings, but one saved
 * by Acrobat or most editors packs them into compressed object streams as UTF-16,
 * and the machine has no PDF library to fall back on, so reading the bytes
 * ourselves is not an option.
 *
 * PDFium is initialised once, on first use, and every call opens, reads and
 * closes its document. The engine is synchronous under its task API, so calls
 * do not interleave.
 *
 * NOTE: no `electron` import, so the node test project can load this.
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { init } from '@embedpdf/pdfium'
import { PdfiumNative } from '@embedpdf/engines/pdfium'
import type { PdfAnnotationObject, PdfDocumentObject, PdfPageObject, Rect } from '@embedpdf/models'
import {
  commentThreads,
  glyphRuns,
  PDF_TEXT_MARKUP_SUBTYPES,
  type PdfAnnotationInput,
  type PdfCommentThread,
} from '@holi/shared'

export type PdfCommentsResult =
  | { ok: true; threads: PdfCommentThread[] }
  | { ok: false; reason: 'not-found' | 'not-pdf' | 'password' }

/** PDFium's error codes, as `@embedpdf/models` numbers them. */
const PASSWORD = 4

const arrayBuffer = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

let enginePromise: Promise<PdfiumNative> | null = null

function engine(): Promise<PdfiumNative> {
  enginePromise ??= (async () => {
    // Resolved from this module rather than bundled: main's build keeps
    // dependencies external, so the wasm is read out of node_modules in dev and
    // in a built app alike. `import.meta.url` does not survive the CJS build.
    const wasm = createRequire(__filename).resolve('@embedpdf/pdfium/pdfium.wasm')
    const mod = await init({ wasmBinary: arrayBuffer(await readFile(wasm)) })
    mod.PDFiumExt_Init()
    return new PdfiumNative(mod)
  })()
  // A failed start is not cached: the next call tries again.
  enginePromise.catch(() => {
    enginePromise = null
  })
  return enginePromise
}

const flat = (r: Rect) => ({
  x: r.origin.x,
  y: r.origin.y,
  width: r.size.width,
  height: r.size.height,
})

/** The code a rejected PDFium task carries, if it carries one. */
const codeOf = (error: unknown): number | undefined =>
  (error as { reason?: { code?: unknown } } | null)?.reason?.code as number | undefined

export async function readPdfComments(absPath: string): Promise<PdfCommentsResult> {
  let bytes: Buffer
  try {
    bytes = await readFile(absPath)
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  const pdfium = await engine()
  let doc: PdfDocumentObject
  try {
    doc = await pdfium
      .openDocumentBuffer({
        id: `comments:${absPath}`,
        content: arrayBuffer(bytes),
      })
      .toPromise()
  } catch (error) {
    return { ok: false, reason: codeOf(error) === PASSWORD ? 'password' : 'not-pdf' }
  }
  try {
    const input: PdfAnnotationInput[] = []
    for (const page of doc.pages) {
      const annotations = await pdfium.getPageAnnotations(doc, page).toPromise()
      const markedText = markedTextReader(pdfium, doc, page)
      for (const a of annotations) input.push(await toInput(a, markedText))
    }
    return { ok: true, threads: commentThreads(input) }
  } finally {
    await pdfium.closeDocument(doc).toPromise()
  }
}

/**
 * The text a mark covers. embedpdf writes it into the mark (`custom.text`);
 * another tool stores only rectangles, so the words are read back from the
 * page's glyphs under them. The glyphs are read at most once per page.
 */
function markedTextReader(pdfium: PdfiumNative, doc: PdfDocumentObject, page: PdfPageObject) {
  let glyphs: Promise<{ x: number; y: number; width: number; height: number }[]> | null = null
  return async (a: PdfAnnotationObject): Promise<string | undefined> => {
    const custom = (a.custom as { text?: unknown } | undefined)?.text
    if (typeof custom === 'string' && custom.trim() !== '') return custom
    if (!PDF_TEXT_MARKUP_SUBTYPES.includes(a.type)) return undefined
    const rects = 'segmentRects' in a && Array.isArray(a.segmentRects) ? a.segmentRects : [a.rect]
    glyphs ??= pdfium
      .getPageGlyphs(doc, page)
      .toPromise()
      .then((gs) => gs.map((g) => flat({ origin: g.origin, size: g.size })))
    const runs = glyphRuns(await glyphs, rects.map(flat))
    if (runs.length === 0) return undefined
    const slices = await pdfium
      .getTextSlices(
        doc,
        runs.map((r) => ({ pageIndex: page.index, charIndex: r.start, charCount: r.count })),
      )
      .toPromise()
    return slices.join(' ')
  }
}

async function toInput(
  a: PdfAnnotationObject,
  markedText: (a: PdfAnnotationObject) => Promise<string | undefined>,
): Promise<PdfAnnotationInput> {
  const text = await markedText(a)
  return {
    id: a.id,
    subtype: a.type,
    pageIndex: a.pageIndex,
    rect: flat(a.rect),
    ...(a.author === undefined ? {} : { author: a.author }),
    ...(a.created === undefined ? {} : { created: a.created }),
    ...(a.modified === undefined ? {} : { modified: a.modified }),
    ...(a.contents === undefined ? {} : { contents: a.contents }),
    ...(a.inReplyToId === undefined ? {} : { inReplyToId: a.inReplyToId }),
    ...(a.replyType === undefined ? {} : { replyType: a.replyType }),
    ...(text === undefined ? {} : { markedText: text }),
  }
}
