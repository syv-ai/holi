/**
 * Mail HTML → markup that is safe to put in the document.
 *
 * A message body is the most hostile input Holi handles: it is written by
 * whoever felt like emailing the user, and it is the one string in the app that
 * gets rendered as markup rather than as text. Everything here exists because a
 * real mail reader has to render real mail — a designed newsletter flattened to
 * text is not a mail reader — so the answer is to sanitize properly rather than
 * to avoid the problem.
 *
 * It runs in the **renderer**, not in main, for one reason: DOMPurify needs a
 * real DOM, and the renderer has one. Sanitizing in main would mean shipping
 * jsdom and giving the main process a rendering concern.
 *
 * Three separate jobs, and they are worth keeping distinct:
 *
 * 1. **Execution** — DOMPurify's job. Scripts, event handlers, `javascript:`
 *    URLs, and the mXSS shapes that defeat hand-rolled tag strippers. This is
 *    exactly why the work is delegated to a maintained library instead of a
 *    regex: the interesting bypasses are parser bugs, not missing patterns.
 * 2. **Remote content** — ours, and the half that is easy to forget. DOMPurify
 *    stops a script; it does nothing about `<img src="https://tracker/p.gif">`,
 *    which is a read receipt fired from the user's IP the moment the message is
 *    opened. Remote loads are stripped by default and counted, so the UI can
 *    offer the same per-message "load images" every mail client offers.
 * 3. **Containment** — mostly `mail-frame.ts`'s now: a message renders in its
 *    own sandboxed document, so its selectors have nothing of the app to match.
 *    What stays here is the `<form>` family and `<base>` — exfiltration and URL
 *    retargeting, which no amount of framing makes acceptable.
 *
 * **`<style>` stays a forbidden TAG, and the message still gets its stylesheet.**
 * Those are not in tension, and the distinction is the whole design. Forcing the
 * tag back (`ADD_TAGS: ['style']`) measurably changes how DOMPurify *parses*: on
 * the classic `<svg><style><img src=x onerror=…>` payload it stops neutralising
 * the `<img>` inside the style and lets it out as a real element. That is a
 * parser-level regression, and it is declined. But the regression is about the
 * sheet passing through the HTML parser — not about the sheet existing. So the
 * sheet is lifted out of the raw markup as *text* before sanitizing, scrubbed as
 * CSS here, and carried to the frame in `css`, where `mail-frame.ts` puts it in
 * a `<style>` element the app wrote. DOMPurify's input and behaviour are exactly
 * what they were.
 *
 * **Why bother**: MJML — which most marketing mail is built with — puts its
 * column widths in a `min-width` media query and leaves the inline width at
 * 100%, its *mobile* fallback. With the sheet dropped, every multi-column
 * message rendered permanently stacked: a two-column footer became two rows and
 * a product grid became one tall column. Inline `style` attributes are kept as
 * they always were, and are still how the majority of mail is designed.
 *
 * `target` is stripped so a link cannot navigate anything itself — `MailView`
 * intercepts the click and hands the URL to `window.holi.openExternal`, which
 * is the only way a mail link should ever open.
 */
import DOMPurify from 'dompurify'

export interface SanitizedMail {
  /** Safe to hand to `dangerouslySetInnerHTML`. */
  html: string
  /**
   * The message's own stylesheet, lifted out of the markup and scrubbed of the
   * things that fetch. `''` when the message brought none.
   *
   * **Belongs in a `<style>` element the app writes**, never back into the
   * message's markup — see the module note. `mail-frame.ts` is the only intended
   * consumer, and it applies its own guard against a sheet closing the element
   * it lands in.
   */
  css: string
  /** How many remote loads were stripped. `> 0` is what makes the UI offer
   *  "load images"; `0` means there is nothing to unblock. */
  blockedRemoteCount: number
}

export interface SanitizeMailOptions {
  /** The user asked for this message's images. Content decision only — it never
   *  loosens anything in the execution or containment passes. */
  allowRemoteContent?: boolean
}

/**
 * Removed outright rather than left to the default allow-list.
 *
 * The form family is exfiltration: a message that can render a password box and
 * post it somewhere is a phishing page wearing the user's own mail client as
 * chrome. `base` would silently retarget every relative URL in the document.
 * `link` and `meta` would let a message redeclare the frame's own CSP.
 *
 * `style` is listed to make the intent explicit; DOMPurify would drop its
 * contents regardless. The sheet is not lost — `stylesheetOf` lifts it out of
 * the raw markup first, and it reaches the frame through `css` (module note).
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
 * `target` and `ping` are navigation, which the app owns (see the module note).
 * `srcset` and `background` are image loads by another name — forbidden rather
 * than blocked-and-restorable, because a retina variant is not worth the extra
 * state, and `src` still carries the image when the user unblocks.
 */
const FORBID_ATTR = ['target', 'ping', 'srcset', 'background', 'formaction', 'action']

/** Attributes that make the browser fetch something, and that survive the
 *  unblock. `href` is deliberately absent: a link is navigated, not fetched. */
const FETCHING_ATTRS = ['src', 'poster']

/** `https:`, `http:`, and the protocol-relative `//host/…` that inherits
 *  whichever the page is — all three reach the network. */
const REMOTE = /^\s*(?:https?:)?\/\//i
const DATA_URI = /^\s*data:/i
/**
 * A remote fetch hidden in CSS: `background-image: url(https://tracker/p.png)`.
 *
 * Matches the same schemes as `REMOTE` and no more. A `url(data:…)` is left
 * alone deliberately: it fetches nothing, so counting it would make the UI tell
 * the user their images were blocked to stop a disclosure that never existed.
 */
const CSS_REMOTE_URL = /url\(\s*['"]?\s*(?:https?:)?\/\//i

/**
 * Every `<style>` block's contents, lifted from the raw markup.
 *
 * A regex over untrusted HTML, deliberately — building a DOM to find the sheets
 * would mean parsing that HTML with the app's own parser *before* it has been
 * sanitized, which is the thing this module exists to avoid. The capture is
 * treated as CSS text and nothing else: it is scrubbed here and guarded again
 * where it is interpolated, so a mis-capture costs a broken stylesheet rather
 * than an injection. Non-greedy, so it stops at the first close tag.
 */
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi

/** A stylesheet fetching another stylesheet. Removed **always**, not blocked and
 *  restorable: it is not an image, so "load images" would never bring it back,
 *  and counting it would promise a fix that button cannot deliver. The frame's
 *  `default-src 'none'` refuses it too — this is the near half of the same. */
const CSS_IMPORT = /@import\b[^;}]*;?/gi

/**
 * One declaration whose value fetches something remote, e.g.
 * `background-image: url(https://tracker/p.png)`.
 *
 * Bounded by `[^;{}]`, so it cannot run past the declaration it starts in and
 * take a neighbouring rule with it. Declaration-level for the same reason
 * `stripRemoteCss` is: a tracking background sits among the colours and spacing
 * that make the message readable.
 */
const CSS_REMOTE_DECLARATION =
  /[a-zA-Z-]+\s*:\s*[^;{}]*url\(\s*['"]?\s*(?:https?:)?\/\/[^;{}]*/g

export function sanitizeMailHtml(html: string, options: SanitizeMailOptions = {}): SanitizedMail {
  const fragment = DOMPurify.sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR,
    // A message has no business carrying data-* into the app's own DOM.
    ALLOW_DATA_ATTR: false,
    // A fragment rather than a string, so the remote-content pass below asks the
    // DOM what an attribute is instead of pattern-matching serialised markup.
    RETURN_DOM_FRAGMENT: true,
  })

  let blockedRemoteCount = 0
  const allowRemote = options.allowRemoteContent === true

  for (const element of fragment.querySelectorAll('*')) {
    for (const attribute of FETCHING_ATTRS) {
      const value = element.getAttribute(attribute)
      if (value === null || value.trim() === '') continue
      // Nothing is fetched and nothing is disclosed — an inline image is just
      // bytes that were already in the message.
      if (DATA_URI.test(value)) continue
      if (REMOTE.test(value)) {
        if (allowRemote) continue
        element.removeAttribute(attribute)
        blockedRemoteCount++
        continue
      }
      // `cid:` (an inline attachment Holi does not download) and relative URLs,
      // which would resolve against the app's own document. Neither can ever
      // load here, and neither is something "load images" can fix — so they go
      // quietly rather than inflating the count with a promise we cannot keep.
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

  // AFTER the attribute pass, so its blocked urls join the same count — the
  // banner is one statement about the whole message, not one per mechanism.
  const stylesheet = stylesheetOf(html, allowRemote)
  blockedRemoteCount += stylesheet.blocked

  const host = document.createElement('div')
  host.append(fragment)
  return { html: host.innerHTML, css: stylesheet.css, blockedRemoteCount }
}

/**
 * The message's stylesheet, as text, ready for a `<style>` the app writes.
 *
 * Read from the **raw** markup rather than from the sanitized fragment, because
 * by then it is gone — `style` is a forbidden tag and always will be (module
 * note). That ordering is the point of the whole approach: DOMPurify sees the
 * same input it always did, and the sheet takes a route that never touches an
 * HTML parser.
 *
 * Scrubbing is only about what *fetches*. It is deliberately not an attempt to
 * validate CSS or to police what a message may do to its own page: the sheet
 * lands in a document containing nothing but that message, so a rule that
 * restyles `body` is the message restyling itself. The two things it cannot be
 * allowed to do — reach the network, and stop being CSS — are handled here and
 * in `mail-frame.ts` respectively.
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
 * Declaration-level rather than whole-attribute: a tracking `background-image`
 * sits next to the colours and spacing that make the message readable, and
 * throwing the attribute away would visibly break mail to stop one pixel.
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
