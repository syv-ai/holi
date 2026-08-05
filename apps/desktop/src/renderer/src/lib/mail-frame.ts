/**
 * The document a mail message renders into — a sandboxed frame of its own.
 *
 * Sanitizing (`mail-html.ts`) decides what markup is *allowed*; this decides
 * where it *lives*. Putting a message in its own document rather than inline in
 * the app is structural containment: the message gets a page, and the app is no
 * longer that page. Two things follow, and both are why the frame exists.
 *
 * 1. **The message cannot reach the app.** No selector it writes can match an
 *    app element, because there are none in its document. That is what lets
 *    `<style>` blocks be *allowed* again — they were banned only because inline
 *    rendering gave a message's stylesheet the run of the app, and a newsletter
 *    without its stylesheet is a newsletter with its design removed.
 * 2. **A second, far stricter CSP applies.** The frame document declares
 *    `default-src 'none'`, so remote content is blocked by the *browser* and
 *    not only by our attribute pass — including the routes a sanitizer cannot
 *    see, like `@import` inside a stylesheet. When the user loads images, that
 *    policy is what widens, in one place.
 *
 * **`sandbox="allow-same-origin"` and nothing else.** No `allow-scripts`, so
 * nothing in the frame executes; the notorious footgun is granting *both*
 * (content can then remove its own sandbox), which is exactly what is refused
 * here. Same-origin is required so the app can write the document, measure it,
 * and intercept clicks — all of which is the app's script reaching in, never
 * the message's script running out.
 *
 * The frame is written with `document.write` rather than `srcdoc` because the
 * app needs a handle on the document anyway (height, links), and writing gives
 * that on the same tick instead of after a load event.
 *
 * **Two canvases, not one.** The frame originally always took the app's theme,
 * which is right for prose and wrong for mail: real mail declares its ink and
 * inherits its paper, so a dark theme rendered a great deal of it black on
 * black. `bringsOwnDesign` decides which of the two a block gets, and `PAPER`
 * is the other one.
 */
import { useEffect, useState } from 'react'

/** The app tokens a message's page inherits, resolved to real colour values —
 *  a separate document gets no cascade, so they are copied in, not referenced. */
export interface MailPalette {
  background: string
  foreground: string
  muted: string
  border: string
  link: string
  /** Drives `color-scheme`, so the frame's own defaults (scrollbars, form
   *  controls a message might contain) match the app instead of flashing white. */
  scheme: 'light' | 'dark'
}

/** Which app token feeds which part of a message's page. `--card` rather than
 *  `--background`: a message is a panel on the app surface, not the surface. */
const TOKENS: Record<Exclude<keyof MailPalette, 'scheme'>, string> = {
  background: '--card',
  foreground: '--card-foreground',
  muted: '--muted-foreground',
  border: '--border',
  link: '--primary',
}

/**
 * The canvas mail was designed for: white paper, dark ink.
 *
 * **Not a fallback — a deliberate second mode.** Mail is written for a white
 * background and says so only partially: a newsletter sets `color: #333` on its
 * text and leaves the background to the client, because for thirty years the
 * client's background has been white. Render that on a dark surface and the
 * message is dark-on-dark — and the images go with it, because a logo is
 * usually dark ink on transparency and simply disappears.
 *
 * So a message that brings any design of its own gets paper, and only a message
 * that brings none inherits the app's theme. See `bringsOwnDesign`.
 *
 * It doubles as the value used when a token reads empty — which happens in
 * tests, where there is no stylesheet, and would otherwise emit `background:;`
 * and leave the frame transparent.
 */
const PAPER: MailPalette = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  muted: '#666666',
  border: '#d4d4d4',
  link: '#0b57d0',
  scheme: 'light',
}

const FALLBACK = PAPER

/**
 * Does this message bring its own design, or is it prose in an HTML wrapper?
 *
 * **Conservative on purpose: any signal at all means paper.** The failure this
 * guards is asymmetric. Giving paper to a message that did not need it costs a
 * white block in a dark app — visible, ordinary, exactly what every other mail
 * client does. Giving the theme to a message that *did* need paper costs black
 * text on a black background, which is unreadable and reads as a broken app.
 *
 * Four signals, and the last one is not about text at all: a message with
 * images is a designed message even if every colour it uses is the default,
 * because those images were drawn to sit on white.
 *
 * Read from the **raw** HTML rather than the sanitized output, so the answer
 * cannot change when the user loads images — a message must not change colour
 * as a side effect of unblocking a picture. That means it also sees inside
 * `<style>` blocks the sanitizer strips, which errs towards paper. Correct
 * direction.
 */
export function bringsOwnDesign(html: string): boolean {
  return (
    // Any CSS property whose name contains `color` or `background` —
    // `color`, `background-color`, `background-image`, `border-color`. Written
    // as a family rather than a list because the list is the thing that goes
    // stale: `background-color:` was missed by a pattern that only allowed
    // `background:` and `color:`, and a table cell with a background is the
    // most ordinary designed-mail construct there is.
    /(?:^|[\s;"'{])[a-z-]*(?:color|background)[a-z-]*\s*:/i.test(html) ||
    /<font\b/i.test(html) ||
    /\sbgcolor\s*=/i.test(html) ||
    /<img\b/i.test(html)
  )
}

/** The canvas one block of HTML renders on: its own if it brought one, the
 *  app's theme if it did not. */
export function canvasFor(html: string, themed: MailPalette): MailPalette {
  return bringsOwnDesign(html) ? PAPER : themed
}

/**
 * Anything that could end a declaration or open a tag is dropped.
 *
 * Theme values are vault content (D64) — whitelisted and validated in main, so
 * this is not the gate that stops a hostile theme. It is the cheap second one,
 * because these values are interpolated into a stylesheet by hand: without it,
 * a value containing `}` would escape its rule and could restyle the message
 * around it.
 */
function safeCssValue(value: string): string {
  return value.trim().replace(/[^\w\s#(),./%-]/g, '')
}

export function readMailPalette(root: HTMLElement = document.documentElement): MailPalette {
  const computed = getComputedStyle(root)
  const read = (token: string, fallback: string): string => {
    const value = safeCssValue(computed.getPropertyValue(token))
    return value === '' ? fallback : value
  }
  return {
    background: read(TOKENS.background, FALLBACK.background),
    foreground: read(TOKENS.foreground, FALLBACK.foreground),
    muted: read(TOKENS.muted, FALLBACK.muted),
    border: read(TOKENS.border, FALLBACK.border),
    link: read(TOKENS.link, FALLBACK.link),
    // The app is dark-first: `data-theme` is only stamped for light (see
    // `state/theme.ts`), so anything else means dark.
    scheme: root.dataset.theme === 'light' ? 'light' : 'dark',
  }
}

function same(a: MailPalette, b: MailPalette): boolean {
  return (Object.keys(a) as (keyof MailPalette)[]).every((key) => a[key] === b[key])
}

/**
 * The palette, kept current as the theme changes.
 *
 * A vault switch rewrites custom properties on `document.documentElement`
 * (`ThemeApplicator`), which no React state observes — so this watches the
 * attribute directly. Identity is held stable when nothing changed, because the
 * palette is an effect dependency of the frame: returning a fresh object each
 * render would rewrite every open message on every render.
 */
export function useMailPalette(): MailPalette {
  const [palette, setPalette] = useState(readMailPalette)

  useEffect(() => {
    const update = () =>
      setPalette((previous) => {
        const next = readMailPalette()
        return same(previous, next) ? previous : next
      })
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-theme'],
    })
    // The theme may have been applied between the initial read and this effect.
    update()
    return () => observer.disconnect()
  }, [])

  return palette
}

export interface MailFrameOptions {
  /** Already through `sanitizeMailHtml`. Nothing else may be passed here. */
  html: string
  palette: MailPalette
  /** Widens the frame's `img-src`. The sanitizer has made the matching
   *  decision about attributes; this is the same call, enforced by the browser. */
  allowRemoteContent: boolean
}

/**
 * The full HTML document for one message.
 *
 * The base stylesheet is deliberately *first* and specificity-free, so a
 * message's own rules win: these are defaults for mail that brings none, not a
 * restyling of mail that does.
 */
export function mailFrameDocument({ html, palette, allowRemoteContent }: MailFrameOptions): string {
  // `default-src 'none'` covers script, frame, object, connect and font in one
  // go; only what a message legitimately needs is added back.
  const imgSrc = allowRemoteContent ? "img-src data: https: http:" : "img-src data:"
  const csp = ["default-src 'none'", imgSrc, "style-src 'unsafe-inline'", "form-action 'none'"].join(
    '; ',
  )

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
html { color-scheme: ${palette.scheme}; }
/* The frame is sized to this content by the app, so it must never scroll
   vertically on its own — a message that scrolls inside the thread is a
   scroll area within a scroll area, and the wheel stops meaning one thing.
   Horizontal is left alone: a wide table has to go somewhere, and clipping
   it would silently hide content rather than let the user reach it. */
html { overflow-y: hidden; }
body {
  margin: 0; padding: 12px;
  background: ${palette.background}; color: ${palette.foreground};
  font: 13px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  overflow-wrap: break-word;
  overflow-x: auto;
}
img { max-width: 100%; height: auto; }
table { max-width: 100%; }
a { color: ${palette.link}; }
blockquote {
  margin: 0.5em 0; padding-left: 0.75em;
  border-left: 2px solid ${palette.border}; color: ${palette.muted};
}
</style>
</head><body>${html}</body></html>`
}

/** Schemes a mail link may hand to the OS, or `null` to refuse. DOMPurify has
 *  already dropped `javascript:`; this is the second gate, at the point of
 *  action, where a URL would actually leave the app. */
export function openableLink(href: string | null): string | null {
  if (href === null) return null
  return /^\s*(https?|mailto):/i.test(href) ? href.trim() : null
}
