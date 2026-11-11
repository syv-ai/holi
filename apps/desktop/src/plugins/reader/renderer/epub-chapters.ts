/**
 * What a book's pages may be before foliate loads them (docs/features/reader.md).
 *
 * A spine item becomes a frame's document, and a frame's document only carries
 * `INERT_CSP` if foliate unpacks it as XHTML or HTML, which it decides by the
 * manifest's `media-type` spelled exactly. A book could spell it otherwise
 * (`Application/XHTML+XML`, a `; charset=` parameter, `application/xml`) or make
 * a page an SVG, which cannot carry a policy at all; either would load under the
 * app's own policy, which lets remote images through. So every manifest type is
 * brought to its plain lowercase form first, a markup page is named as the type
 * foliate parses, and any other page is shown as an `<img>` inside a page that
 * does carry the policy: an image runs nothing and loads nothing.
 */
import type { Book, View } from './vendor/foliate/view.js'
import { withInertPolicy } from './inert-frame'

/** @public */
export type ChapterType = 'application/xhtml+xml' | 'text/html'

/** A media type's essence: lowercase, without parameters. */
function essence(type: string): string {
  return type.split(';')[0]!.trim().toLowerCase()
}

/** @public The type foliate should parse a page as, or null when it is not markup. */
export function chapterType(type: string): ChapterType | null {
  const plain = essence(type)
  if (plain === 'text/html') return 'text/html'
  if (['application/xhtml+xml', 'application/xml', 'text/xml'].includes(plain))
    return 'application/xhtml+xml'
  return null
}

/** @public A page that shows `src` as an image, with the policy first in its head. */
export function imagePage(src: string): string {
  const escaped = src.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return withInertPolicy(
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title></title></head><body style="margin:0"><img src="${escaped}" alt="" style="display:block;max-width:100%;max-height:100vh;margin:auto"/></body></html>`,
    'application/xhtml+xml',
  )
}

/** Lets go of an open book. foliate's `close` throws on a book whose first
 *  section never loaded, and a throw from an effect's cleanup blanks the app. */
export function closeBook(view: View | null, book: Book | null): void {
  try {
    view?.close()
  } catch (err) {
    console.warn('[reader] closing the book failed:', err)
  }
  view?.remove()
  book?.destroy()
}

/** Brings every page of `book` under the policy; call before it is opened. */
export function guardChapters(book: Book): void {
  for (const item of book.resources.manifest) item.mediaType = essence(item.mediaType)
  // foliate leaves out a spine entry missing from the manifest, so `sections`
  // lines up with the entries it kept, not with the spine.
  const kept = book.resources.spine.filter(
    ({ idref }) => book.resources.getItemByID(idref) !== undefined,
  )
  kept.forEach(({ idref }, index) => {
    const item = book.resources.getItemByID(idref)
    const section = book.sections[index]
    if (item === undefined || section == null) return
    const type = chapterType(item.mediaType)
    if (type !== null) {
      item.mediaType = type
      return
    }
    const load = section.load.bind(section)
    const unload = section.unload.bind(section)
    let page: string | null = null
    section.load = async () => {
      const inner = await load()
      if (inner == null) return inner
      page = URL.createObjectURL(new Blob([imagePage(inner)], { type: 'application/xhtml+xml' }))
      return page
    }
    section.unload = () => {
      if (page !== null) URL.revokeObjectURL(page)
      page = null
      unload()
    }
  })
}
