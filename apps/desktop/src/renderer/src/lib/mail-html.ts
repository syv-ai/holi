/**
 * Mail HTML → markup that is safe to put in the document.
 *
 * A message body is the most hostile input Holi handles and the one string
 * rendered as markup. It runs in the renderer because DOMPurify needs a real
 * DOM. Three separate jobs:
 *
 * 1. Execution: DOMPurify's. Scripts, handlers, `javascript:` URLs and mXSS
 *    shapes; the interesting bypasses are parser bugs, so never a regex.
 * 2. Remote content: ours. A remote `<img>` is a read receipt fired from the
 *    user's IP. Remote loads are stripped by default and counted, so the UI can
 *    offer "load images".
 * 3. Containment: mostly `mail-frame.ts`'s sandboxed document. The `<form>`
 *    family and `<base>` (exfiltration, URL retargeting) are refused here.
 *
 * `<style>` stays a forbidden TAG, yet the message keeps its stylesheet.
 * Allowing the tag (`ADD_TAGS: ['style']`) changes how DOMPurify parses: the
 * classic `<svg><style><img src=x onerror=…>` payload then escapes as a real
 * element. So the sheet is lifted out of the raw markup as text, scrubbed as
 * CSS here, and written into a `<style>` by `mail-frame.ts`; DOMPurify's
 * input is unchanged. It matters because MJML puts column widths in media
 * queries: without the sheet, multi-column mail renders permanently stacked.
 *
 * `target` is stripped: `MailView` intercepts clicks and hands the URL to
 * `window.holi.openExternal`, the only way a mail link may open.
 */
import DOMPurify from 'dompurify'

export interface SanitizedMail {
  /** Safe to hand to `dangerouslySetInnerHTML`. */
  html: string
  /**
   * The message's own stylesheet, scrubbed of what fetches; `''` if none.
   * Belongs in a `<style>` the app writes (`mail-frame.ts`), never back into
   * the markup.
   */
  css: string
  /** How many remote loads were stripped; `> 0` offers "load images". */
  blockedRemoteCount: number
}

export interface SanitizeMailOptions {
  /** The user asked for this message's images. Never loosens the execution or
   *  containment passes. */
  allowRemoteContent?: boolean
}

/**
 * Removed outright rather than left to the default allow-list.
 *
 * The form family is phishing inside the user's own mail client. `base` would
 * retarget every relative URL. `link` and `meta` could redeclare the frame's
 * CSP. `style` is explicit intent; `stylesheetOf` has already lifted the sheet.
 */
const FORBID_TAGS = [
  'style',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'base',
  'link',
  'meta',
]

/**
 * `target` and `ping` are navigation, which the app owns. `srcset` and
 * `background` are image loads, forbidden rather than restorable: `src` still
 * carries the image when the user unblocks.
 */
const FORBID_ATTR = ['target', 'ping', 'srcset', 'background', 'formaction', 'action']

/** Attributes that make the browser fetch something, and that survive the
 *  unblock. `href` is deliberately absent: a link is navigated, not fetched. */
const FETCHING_ATTRS = ['src', 'poster']

/** `https:`, `http:`, and protocol-relative `//host/…`: all reach the network. */
const REMOTE = /^\s*(?:https?:)?\/\//i
const DATA_URI = /^\s*data:/i
/**
 * A remote fetch hidden in CSS: `background-image: url(https://tracker/p.png)`.
 *
 * Same schemes as `REMOTE`. `url(data:…)` fetches nothing, so it is not
 * counted.
 */
const CSS_REMOTE_URL = /url\(\s*['"]?\s*(?:https?:)?\/\//i

/**
 * Every `<style>` block's contents, lifted from the raw markup.
 *
 * A regex, deliberately: a DOM would parse the HTML before it is sanitized.
 * The capture is only ever CSS text, scrubbed here and guarded again where
 * interpolated, so a mis-capture costs a broken stylesheet, not an injection.
 */
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi

/** A stylesheet fetching another. Always removed and not counted: "load
 *  images" would not restore it. The frame's CSP refuses it too. */
const CSS_IMPORT = /@import\b[^;}]*;?/gi

/**
 * One declaration whose value fetches something remote, e.g.
 * `background-image: url(https://tracker/p.png)`.
 *
 * Bounded by `[^;{}]`, so it cannot take a neighbouring rule with it.
 */
const CSS_REMOTE_DECLARATION =
  /[a-zA-Z-]+\s*:\s*[^;{}]*url\(\s*['"]?\s*(?:https?:)?\/\/[^;{}]*/g

export function sanitizeMailHtml(html: string, options: SanitizeMailOptions = {}): SanitizedMail {
  const fragment = DOMPurify.sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR,
    // A message has no business carrying data-* into the app's own DOM.
    ALLOW_DATA_ATTR: false,
    // A fragment, so the remote pass reads attributes from the DOM rather than
    // pattern-matching markup.
    RETURN_DOM_FRAGMENT: true,
  })

  let blockedRemoteCount = 0
  const allowRemote = options.allowRemoteContent === true

  for (const element of fragment.querySelectorAll('*')) {
    for (const attribute of FETCHING_ATTRS) {
      const value = element.getAttribute(attribute)
      if (value === null || value.trim() === '') continue
      // An inline image fetches nothing.
      if (DATA_URI.test(value)) continue
      if (REMOTE.test(value)) {
        if (allowRemote) continue
        element.removeAttribute(attribute)
        blockedRemoteCount++
        continue
      }
      // `cid:` (not downloaded) and relative URLs (would resolve against the
      // app) can never load, so they go without being counted.
      element.removeAttribute(attribute)
    }

    const style = element.getAttribute('style')
    if (style !== null && !allowRemote) {
      const cleaned = stripRemoteCss(style)
      blockedRemoteCount += cleaned.blocked
      if (cleaned.blocked > 0) {
        if (cleaned.style === '') element.removeAttribute('style')
        else element.setAttribute('style', cleaned.style)
      }
    }
  }

  // Its blocked urls join the same count: one banner per message.
  const stylesheet = stylesheetOf(html, allowRemote)
  blockedRemoteCount += stylesheet.blocked

  const host = document.createElement('div')
  host.append(fragment)
  return { html: host.innerHTML, css: stylesheet.css, blockedRemoteCount }
}

/**
 * The message's stylesheet, as text, ready for a `<style>` the app writes.
 *
 * Read from the raw markup, never through an HTML parser (module note).
 * Scrubbing is only about what fetches, not CSS validation: the sheet can only
 * restyle its own message. Escaping the element is `mail-frame.ts`'s guard.
 */
function stylesheetOf(html: string, allowRemote: boolean): { css: string; blocked: number } {
  const sheets = [...html.matchAll(STYLE_BLOCK)].map((match) => match[1] ?? '')
  if (sheets.length === 0) return { css: '', blocked: 0 }

  // Joined in document order, which is the order they cascade in.
  let css = sheets.join('\n').replace(CSS_IMPORT, '')

  let blocked = 0
  if (!allowRemote) {
    css = css.replace(CSS_REMOTE_DECLARATION, () => {
      blocked++
      return ''
    })
  }

  return { css: css.trim(), blocked }
}

/**
 * Drop the CSS declarations that fetch, keep the ones that only style.
 *
 * Declaration-level: dropping the whole attribute would break the message's
 * layout to stop one tracking pixel.
 */
function stripRemoteCss(style: string): { style: string; blocked: number } {
  let blocked = 0
  const kept = style
    .split(';')
    .filter((declaration) => {
      if (!CSS_REMOTE_URL.test(declaration)) return true
      blocked++
      return false
    })
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration !== '')

  return { style: kept.join('; '), blocked }
}
