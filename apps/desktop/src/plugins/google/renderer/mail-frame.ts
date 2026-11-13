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
 * Light mode preserves sender-designed paper. Dark mode uses the app palette
 * and removes author paint declarations while retaining layout and imagery.
 */
import { useEffect, useState } from 'react'
import postcss, { type Declaration } from 'postcss'
import valueParser from 'postcss-value-parser'

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
 * The canvas mail was designed for: white paper, dark ink. It remains the
 * fallback when a token reads empty (tests have no stylesheet).
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
 * @public exported for its test
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
  // Authored colors assume a light canvas. Keep that design in light mode;
  // dark mode preserves the app surface and normalizes authored paint below.
  return themed.scheme === 'dark' || !bringsOwnDesign(html) ? themed : PAPER
}

/**
 * Anything that could end a declaration or open a tag is dropped.
 *
 * Theme values are validated in main; this is the cheap second gate,
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

/** @public exported for its test */
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
    // The app is dark-first: `data-theme` is only stamped for light, so anything else means dark.
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
  const imgSrc = allowRemoteContent ? 'img-src data: https: http:' : 'img-src data:'
  const csp = [
    "default-src 'none'",
    imgSrc,
    "style-src 'unsafe-inline'",
    "form-action 'none'",
  ].join('; ')

  // Dark mode strips only authored paint (not layout rules) before writing the
  // content into this isolated document. Images and the strict frame policy
  // are unaffected. Light mode retains sender styling as before.
  const content = palette.scheme === 'dark' ? normalizeDarkMail(html, css) : { html, css }

  // Order matters: defaults the message may override, the message, then the
  // rules it may not.
  const sheets = [
    defaults(palette),
    content.css === '' ? '' : safeStylesheet(content.css),
    INVARIANTS,
  ]
    .filter((sheet) => sheet !== '')
    .map((sheet) => `<style>${sheet}</style>`)
    .join('\n')

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
${sheets}
</head><body>${content.html}</body></html>`
}

/** Normalize authored paint while retaining the message's structure and layout. */
function normalizeDarkMail(html: string, css: string): { html: string; css: string } {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  for (const element of parsed.body.querySelectorAll('body, body *')) {
    for (const attribute of ['color', 'bgcolor', 'text', 'link', 'vlink', 'alink']) {
      element.removeAttribute(attribute)
    }
    const inline = element.getAttribute('style')
    if (inline !== null) {
      element.setAttribute('style', normalizeDeclarations(`x{${inline}}`))
      if (element.getAttribute('style') === '') element.removeAttribute('style')
    }
  }

  return { html: parsed.body.innerHTML, css: stripStylesheetPaint(css) }
}

/** Layout keywords retained when a background shorthand loses its paint. */
const BACKGROUND_LAYOUT_WORDS = new Set([
  'left',
  'right',
  'top',
  'bottom',
  'center',
  'cover',
  'contain',
  'repeat',
  'no-repeat',
  'repeat-x',
  'repeat-y',
  'space',
  'round',
  'local',
  'fixed',
  'scroll',
  'border-box',
  'padding-box',
  'content-box',
  'text',
  'none',
])

function normalizeDeclarations(css: string): string {
  try {
    const root = postcss.parse(css)
    root.walkDecls((declaration) => normalizeDeclaration(declaration))
    const rule = root.first
    return rule?.type === 'rule' ? (rule.nodes?.map((node) => node.toString()).join(';') ?? '') : ''
  } catch {
    // Malformed inline CSS cannot be normalized safely; discard the style.
    return ''
  }
}

/** Strip authored paint while preserving the declaration's layout tokens. */
function normalizeDeclaration(declaration: Declaration): void {
  const property = declaration.prop.toLowerCase()
  if (property === 'color' || property.endsWith('-color')) {
    declaration.remove()
  } else if (property === 'background') {
    const layers: valueParser.Node[][] = [[]]
    for (const node of valueParser(declaration.value).nodes) {
      if (node.type === 'div' && node.value === ',') layers.push([])
      else layers[layers.length - 1]!.push(node)
    }
    declaration.value = layers
      .map((nodes) => {
        const kept = nodes.filter((node) => {
          if (node.type === 'function')
            return ['url', 'calc', 'min', 'max', 'clamp', 'env'].includes(node.value.toLowerCase())
          if (node.type !== 'word') return node.type === 'div' || node.type === 'space'
          return (
            BACKGROUND_LAYOUT_WORDS.has(node.value.toLowerCase()) ||
            /^[-+]?(?:\d*\.)?\d+(?:%|[a-z]+)?$/i.test(node.value)
          )
        })
        const hadGradient = nodes.some(
          (node) => node.type === 'function' && node.value.toLowerCase().endsWith('-gradient'),
        )
        const hasUrl = kept.some(
          (node) => node.type === 'function' && node.value.toLowerCase() === 'url',
        )
        if (hadGradient && !hasUrl) kept.unshift(valueParser('none').nodes[0]!)
        return valueParser.stringify(kept).trim()
      })
      .join(', ')
    if (declaration.value === '') declaration.remove()
  } else if (property === 'background-image') {
    const layers: valueParser.Node[][] = [[]]
    for (const node of valueParser(declaration.value).nodes) {
      if (node.type === 'div' && node.value === ',') layers.push([])
      else layers[layers.length - 1]!.push(node)
    }
    declaration.value = layers
      .map((nodes) => {
        const images = nodes.flatMap((node): valueParser.Node[] => {
          if (node.type !== 'function') return []
          if (node.value.toLowerCase() === 'url') return [node]
          if (node.value.toLowerCase().endsWith('-gradient')) return [valueParser('none').nodes[0]!]
          return []
        })
        return images.length === 0 ? 'none' : valueParser.stringify(images)
      })
      .join(', ')
    if (declaration.value === '') declaration.remove()
  }
}

function stripStylesheetPaint(css: string): string {
  // PostCSS parses nested rules, comments and functions as syntax, rather than
  // guessing declaration boundaries with a regular expression. Its AST stays
  // entirely in memory; sender styles never enter the app document.
  try {
    const root = postcss.parse(safeStylesheet(css))
    root.walkDecls(normalizeDeclaration)
    return root.toString()
  } catch {
    // Invalid CSS has no reliable declaration boundaries. Discard it in dark
    // mode rather than risk leaving sender paint in a partially parsed sheet.
    return ''
  }
}

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
