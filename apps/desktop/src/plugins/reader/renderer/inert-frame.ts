/**
 * The rules for a frame that holds a file's content (docs/features/reader.md):
 * what it may load, the document it starts as, and what a click on a link does.
 *
 * The frame itself is `sandbox="allow-same-origin"` and nothing else, so no
 * script inside it ever runs: the app's script builds the content into the
 * inert document. The policy below is the second layer, and the one that stops
 * the network: a file can only show what it carries inside itself, as `data:`
 * or `blob:` URLs the renderer libraries make from the zip.
 */
import { openExternal } from '@/plugin-api'

/** What file content may load. Every frame holding a file's content declares
 *  exactly this, the epub's chapter documents included. */
const INERT_CSP = [
  "default-src 'none'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data: blob:',
  "style-src 'unsafe-inline' data: blob:",
  "form-action 'none'",
].join('; ')

/** A frame's whole starting document: the policy before anything else, then
 *  the canvas the pages sit on and any stylesheet the caller adds. */
export function inertFrameDocument({
  css = '',
  background,
}: {
  css?: string
  background: string
}): string {
  return `<!doctype html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="${INERT_CSP}">
<meta charset="utf-8">
<style>html, body { margin: 0; background: ${background}; }</style>
${css === '' ? '' : `<style>${css}</style>`}
</head><body></body></html>`
}

/** A web page or a mail draft: the only links that leave the file. Main's
 *  `holi:openExternal` holds the same line whatever it is sent. */
const EXTERNAL = /^(https?:\/\/|mailto:)/i

const XLINK = 'http://www.w3.org/1999/xlink'

/** A scheme that would run or reach something rather than move within the file. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * A click inside a file's frame. A link never navigates the frame: the
 * default is prevented first, then a web or mail link opens in the browser,
 * a link within the file goes to `onInternal`, and anything else does nothing.
 */
export function followLink(event: MouseEvent, onInternal?: (href: string) => void): void {
  // Any link, not only `a[href]`: an image map's `area`, and an SVG `a`, whose
  // target may be `xlink:href`.
  const anchor = (event.target as Element | null)?.closest?.('a, area')
  if (anchor == null) return
  event.preventDefault()
  const href = (anchor.getAttribute('href') ?? anchor.getAttributeNS(XLINK, 'href') ?? '').trim()
  if (!openOutside(href) && !SCHEME.test(href) && href !== '') onInternal?.(href)
}

/** Opens a link that leaves the file in the browser, if it is a web or mail
 *  link; answers whether it did. */
export function openOutside(href: string): boolean {
  if (!EXTERNAL.test(href.trim())) return false
  openExternal(href.trim())
  return true
}

const XHTML = 'http://www.w3.org/1999/xhtml'
const BLANK_PAGE = `<html xmlns="${XHTML}"><head><title></title></head><body></body></html>`

/**
 * A chapter's markup with `INERT_CSP` as the first thing in its head, made
 * with a real parser so a `<head>` inside a comment or a string cannot take
 * the policy somewhere it does nothing. The head is the one the browser reads
 * a policy from: an XHTML `head` that is a child of an XHTML `html` root, the
 * document's `head`. A `head` in another namespace looks the same to a
 * selector but holds no policy, so a chapter with only that gets a real one.
 */
export function withInertPolicy(
  markup: string,
  type: 'application/xhtml+xml' | 'text/html',
): string {
  const doc = new DOMParser().parseFromString(markup, type)
  const root = doc.documentElement
  // A `<meta>` only counts in an HTML document's head, and an `<svg>`, a
  // `<body>` or an invented root has none. Nothing to read there.
  if (root.namespaceURI !== XHTML || root.localName !== 'html')
    return withInertPolicy(BLANK_PAGE, 'application/xhtml+xml')
  const head =
    [...root.children].find(
      (child) => child.namespaceURI === XHTML && child.localName === 'head',
    ) ?? doc.createElementNS(XHTML, 'head')
  // First in the root as well: a policy covers only what is fetched after it,
  // so a head written after the body must not count on the parser holding
  // the body's images back.
  root.prepend(head)
  const meta = doc.createElementNS(XHTML, 'meta')
  meta.setAttribute('http-equiv', 'Content-Security-Policy')
  meta.setAttribute('content', INERT_CSP)
  head.prepend(meta)
  return type === 'text/html'
    ? `<!doctype html>${root.outerHTML}`
    : // The root alone: an `<?xml-stylesheet?>` written before it is fetched
      // as it is parsed, before the policy exists.
      new XMLSerializer().serializeToString(root)
}

/**
 * Sends a shortcut pressed inside a frame on to `target` in the app: a key
 * pressed in a frame does not cross into the app, so ⌘K or ⌘F would
 * otherwise die there. (⌘W is a menu accelerator and needs no help.) Returns the listener's removal.
 */
export function forwardShortcuts(doc: Document, target: EventTarget): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.metaKey && !event.ctrlKey) return
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        bubbles: true,
        cancelable: true,
      }),
    )
  }
  doc.addEventListener('keydown', onKeyDown)
  return () => doc.removeEventListener('keydown', onKeyDown)
}
