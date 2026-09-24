/**
 * The open PDF's comment threads, read from the viewer's own store, for an ask
 * sent from the top bar (D106).
 *
 * The store rather than the file, so a mark made a moment ago is in the ask
 * before its one-second save. The threads themselves, and how they are written
 * down, are `@holi/shared`'s: `holi pdf comments` reads the saved file through
 * the same rules, so the two read alike.
 */
import {
  commentThreads,
  glyphRuns,
  PDF_TEXT_MARKUP_SUBTYPES,
  type PdfAnnotationInput,
  type PdfCommentThread,
} from '@holi/shared'

export const ASK_AGENT_THREAD = 'holi:ask-agent-thread'
/** With no comment selected the button asks about the PDF itself: the way
 *  into a chat about the file, whatever it is marked with. */
export const ASK_AGENT_PDF = 'holi:ask-agent-pdf'

interface Rect {
  origin: { x: number; y: number }
  size: { width: number; height: number }
}

/** The fields of an embedpdf annotation object this reads. */
interface StoreAnnotation {
  id: string
  type: number
  pageIndex: number
  rect: Rect
  segmentRects?: Rect[]
  author?: string
  created?: Date
  modified?: Date
  contents?: string
  inReplyToId?: string
  replyType?: number
  custom?: { text?: unknown }
}

interface AnnotationDocState {
  byUid?: Record<string, { object?: StoreAnnotation } | undefined>
  selectedUids?: string[]
}

const flat = (r: Rect) => ({
  x: r.origin.x,
  y: r.origin.y,
  width: r.size.width,
  height: r.size.height,
})

function docState(state: unknown, documentId: string): AnnotationDocState | undefined {
  return (
    state as {
      plugins?: { annotation?: { documents?: Record<string, AnnotationDocState | undefined> } }
    }
  )?.plugins?.annotation?.documents?.[documentId]
}

function objectsIn(state: unknown, documentId: string): StoreAnnotation[] {
  const byUid = docState(state, documentId)?.byUid ?? {}
  return Object.values(byUid).flatMap((t) => (t?.object === undefined ? [] : [t.object]))
}

const savedText = (a: StoreAnnotation): string | undefined =>
  typeof a.custom?.text === 'string' && a.custom.text.trim() !== '' ? a.custom.text : undefined

function toInput(a: StoreAnnotation, markedText: string | undefined): PdfAnnotationInput {
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
    ...(markedText === undefined ? {} : { markedText }),
  }
}

/** The threads as the store has them, with only embedpdf's saved marked text.
 *  Cheap and synchronous: what a command's `visible` and `disabled` read. */
export function threadsInViewer(state: unknown, documentId: string): PdfCommentThread[] {
  return commentThreads(objectsIn(state, documentId).map((a) => toInput(a, savedText(a))))
}

/** The id of the selected annotation, if one is selected; a mark grouped under
 *  another (Replace Text's strikeout) answers with its leader's. */
export function selectedAnnotationId(state: unknown, documentId: string): string | null {
  const doc = docState(state, documentId)
  const uid = doc?.selectedUids?.[0]
  const object = uid === undefined ? undefined : doc?.byUid?.[uid]?.object
  if (object === undefined) return null
  return object.replyType === 2 && object.inReplyToId !== undefined ? object.inReplyToId : object.id
}

/** The thread the annotation with `id` belongs to, as its mark or a reply. */
export function threadOf(threads: PdfCommentThread[], id: string | null): PdfCommentThread | null {
  if (id === null) return null
  return threads.find((t) => t.id === id || t.replies.some((r) => r.id === id)) ?? null
}

/** The slice of embedpdf's engine this needs: the viewer's, over its worker. */
export interface GlyphEngine {
  getPageGlyphs(
    doc: unknown,
    page: unknown,
  ): {
    toPromise(): Promise<{ origin: Rect['origin']; size: Rect['size'] }[]>
  }
  getTextSlices(
    doc: unknown,
    slices: { pageIndex: number; charIndex: number; charCount: number }[],
  ): { toPromise(): Promise<string[]> }
}

/**
 * The threads for an ask, with the marked text of a mark another tool wrote
 * read back from the page's glyphs, the way `holi pdf comments` does, so an
 * Acrobat highlight reads the same in both. Falls back to what the store has
 * if the engine cannot say.
 */
export async function threadsForAsk(
  state: unknown,
  documentId: string,
  engine: GlyphEngine | null,
): Promise<PdfCommentThread[]> {
  const objects = objectsIn(state, documentId)
  const doc = (
    state as { core?: { documents?: Record<string, { document?: unknown } | undefined> } }
  )?.core?.documents?.[documentId]?.document as { pages?: { index: number }[] } | undefined
  const glyphs = new Map<number, Promise<ReturnType<typeof flat>[]>>()
  const recovered = async (a: StoreAnnotation): Promise<string | undefined> => {
    const saved = savedText(a)
    if (saved !== undefined || engine === null || doc === undefined) return saved
    if (!PDF_TEXT_MARKUP_SUBTYPES.includes(a.type)) return undefined
    const page = doc.pages?.find((p) => p.index === a.pageIndex)
    if (page === undefined) return undefined
    try {
      let pageGlyphs = glyphs.get(a.pageIndex)
      if (pageGlyphs === undefined) {
        pageGlyphs = engine
          .getPageGlyphs(doc, page)
          .toPromise()
          .then((gs) => gs.map((g) => flat({ origin: g.origin, size: g.size })))
        glyphs.set(a.pageIndex, pageGlyphs)
      }
      const runs = glyphRuns(await pageGlyphs, (a.segmentRects ?? [a.rect]).map(flat))
      if (runs.length === 0) return undefined
      const slices = await engine
        .getTextSlices(
          doc,
          runs.map((r) => ({ pageIndex: a.pageIndex, charIndex: r.start, charCount: r.count })),
        )
        .toPromise()
      return slices.join(' ')
    } catch {
      return undefined
    }
  }
  return commentThreads(await Promise.all(objects.map(async (a) => toInput(a, await recovered(a)))))
}
