/**
 * The document a mail message renders into: a sandboxed frame of its own.
 * Sanitizing (`mail-html.ts`) decides what markup is allowed; this decides
 * where it lives.
 *
 * 1. The message cannot reach the app: its document holds no app elements, so
 *    its stylesheet is safe to honour. The sheet arrives as `css` text written
 *    into a `<style>` this module builds; the `<style>` tag stays forbidden in
 *    the markup for a parser reason (`mail-html.ts`).
 * 2. A far stricter CSP applies (`default-src 'none'`), so the browser blocks
 *    remote content, including routes a sanitizer cannot see like `@import`.
 *    Loading images widens that policy in one place.
 *
 * `sandbox="allow-same-origin"` and nothing else. Never add `allow-scripts`:
 * both together let content remove its own sandbox. Same-origin lets the app
 * write, measure and intercept clicks in the document.
 *
 * `document.write` rather than `srcdoc` gives the app the document handle on
 * the same tick instead of after a load event.
 *
 * Two canvases: mail usually declares its ink and inherits white paper, so
 * `bringsOwnDesign` picks `PAPER` or the app theme per block.
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
 * A deliberate second mode: mail sets its text colour and leaves the
 * background to the client, which has always been white, so on a dark surface
 * it and its transparent logos disappear. See `bringsOwnDesign`.
 *
 * Also the fallback when a token reads empty (tests have no stylesheet), which
 * would otherwise leave the frame transparent.
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
 * Any signal means paper, because the failure is asymmetric: unneeded paper is
 * a white block, as in every mail client; a missing one is black on black.
 * Images count too: they were drawn to sit on white.
 *
 * Read from the raw HTML, so unblocking images cannot change a message's
 * colour. It also sees `<style>` blocks the sanitizer strips, erring towards
 * paper.
 */
export function bringsOwnDesign(html: string): boolean {
  return (
    // Any CSS property whose name contains `color` or `background`, as a
    // family rather than a list that goes stale.
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
 * Theme values (D64) are validated in main; this is the cheap second gate,
 * since they are interpolated into a stylesheet by hand and a `}` would escape
 * its rule.
 */
function safeCssValue(value: string): string {
  return value.trim().replace(/[^\w\s#(),./%-]/g, '')
}

/**
 * A whole stylesheet, made safe to interpolate into a `<style>` element.
 *
 * Only `</` is removed: it is the one way out of the element, and no
 * stylesheet needs it. Deliberately not a CSS validator: the sheet can only
 * restyle the message itself. The network is `sanitizeMailHtml`'s and the
 * CSP's job.
 */
function safeStylesheet(css: string): string {
  return css.replace(/<\//g, '')
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
 * A vault switch rewrites custom properties on the root, which no React state
 * observes, so this watches the attributes. Identity is stable when nothing
 * changed: the palette is an effect dependency of every open frame.
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
  /** The message's own stylesheet, from the same `sanitizeMailHtml` call. */
  css?: string
  palette: MailPalette
  /** Widens the frame's `img-src`. The sanitizer has made the matching
   *  decision about attributes; this is the same call, enforced by the browser. */
  allowRemoteContent: boolean
}

/** The full HTML document for one message. */
export function mailFrameDocument({
  html,
  css = '',
  palette,
  allowRemoteContent,
}: MailFrameOptions): string {
  // `default-src 'none'` covers script, frame, object, connect and font in one
  // go; only what a message legitimately needs is added back.
  const imgSrc = allowRemoteContent ? "img-src data: https: http:" : "img-src data:"
  const csp = ["default-src 'none'", imgSrc, "style-src 'unsafe-inline'", "form-action 'none'"].join(
    '; ',
  )

  // Order matters: defaults the message may override, the message, then the
  // rules it may not.
  const sheets = [defaults(palette), css === '' ? '' : safeStylesheet(css), INVARIANTS]
    .filter((sheet) => sheet !== '')
    .map((sheet) => `<style>${sheet}</style>`)
    .join('\n')

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
${sheets}
</head><body>${html}</body></html>`
}

/** Defaults for mail that brings none: first and specificity-free, so a
 *  message's own rules win. */
function defaults(palette: MailPalette): string {
  return `
html { color-scheme: ${palette.scheme}; }
body {
  margin: 0; padding: 12px;
  background: ${palette.background}; color: ${palette.foreground};
  font: 13px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  overflow-wrap: break-word;
}
img { max-width: 100%; height: auto; }
table { max-width: 100%; }
a { color: ${palette.link}; }
blockquote {
  margin: 0.5em 0; padding-left: 0.75em;
  border-left: 2px solid ${palette.border}; color: ${palette.muted};
}
`
}

/**
 * The only rules a message may not override, placed last. Structural: the app
 * sizes the frame to its content, so vertical scrolling would nest a scroll
 * area in the thread, and a wide table needs `overflow-x: auto` rather than
 * being clipped under the frame edge.
 */
const INVARIANTS = `
html { overflow-y: hidden; }
body { overflow-x: auto; }
`

/** Schemes a mail link may hand to the OS, or `null` to refuse. The second
 *  gate after DOMPurify, where a URL would actually leave the app. */
export function openableLink(href: string | null): string | null {
  if (href === null) return null
  return /^\s*(https?|mailto):/i.test(href) ? href.trim() : null
}
