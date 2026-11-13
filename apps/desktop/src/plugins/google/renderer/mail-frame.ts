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

const DARK: MailPalette = {
  background: '#121212',
  foreground: '#f5f5f5',
  muted: '#a3a3a3',
  border: '#3f3f46',
  link: '#8ab4f8',
  scheme: 'dark',
}

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
  // The app is dark-first: `data-theme` is only stamped for light, so anything else means dark.
  const scheme = root.dataset.theme === 'light' ? 'light' : 'dark'
  const fallback = scheme === 'light' ? PAPER : DARK
  const read = (token: string, fallbackValue: string): string => {
    const value = safeCssValue(computed.getPropertyValue(token))
    return value === '' ? fallbackValue : value
  }
  return {
    background: read(TOKENS.background, fallback.background),
    foreground: read(TOKENS.foreground, fallback.foreground),
    muted: read(TOKENS.muted, fallback.muted),
    border: read(TOKENS.border, fallback.border),
    link: read(TOKENS.link, fallback.link),
    scheme,
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

/** Decode CSS escapes in an identifier. */
function decodeCssIdentifier(identifier: string): string {
  return identifier.replace(
    /\\([0-9a-fA-F]{1,6})(?:\r\n|[\t\n\r\f ])?|\\([^\n\r\f])/g,
    (_match, hex: string | undefined, escaped: string | undefined) => {
      if (hex !== undefined) {
        const codePoint = Number.parseInt(hex, 16)
        return String.fromCodePoint(
          codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
            ? 0xfffd
            : codePoint,
        )
      }
      return escaped ?? ''
    },
  )
}

/** Original parser nodes grouped as one CSS identifier for classification. */
type BackgroundToken = {
  type: valueParser.Node['type']
  value: string
  nodes: valueParser.Node[]
}

/** Join only whitespace consumed by a CSS hex escape for classification. */
function backgroundTokens(nodes: valueParser.Node[]): BackgroundToken[] {
  const tokens: BackgroundToken[] = []
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!
    const previous = tokens.at(-1)
    const next = nodes[index + 1]
    if (
      previous?.type === 'word' &&
      /(?:^|[^\\])(?:\\\\)*\\[0-9a-f]{1,6}$/i.test(previous.value) &&
      node.type === 'space' &&
      /^(?:\r\n|[\t\n\r\f ])$/.test(node.value) &&
      (next?.type === 'word' || next?.type === 'function')
    ) {
      previous.nodes.push(node, next)
      previous.value += node.value + next.value
      previous.type = next.type
      index += 1
      continue
    }
    tokens.push({ type: node.type, value: node.value, nodes: [node] })
  }
  return tokens
}

/** Recover CSS priority written with escapes before paint tokens are filtered. */
function preserveEscapedImportant(declaration: Declaration): void {
  const parsed = valueParser(declaration.value)
  const nodes = parsed.nodes
  const isTrivia = (node: valueParser.Node) => node.type === 'space' || node.type === 'comment'
  let end = nodes.length - 1
  while (end >= 0 && isTrivia(nodes[end]!)) end -= 1
  const priority = backgroundTokens(nodes.slice(0, end + 1)).at(-1)
  if (priority?.type !== 'word') return
  const decoded = decodeCssIdentifier(priority.value).toLowerCase()
  const priorityStart = nodes.indexOf(priority.nodes[0]!)
  if (decoded === '!important') {
    nodes.splice(priorityStart, priority.nodes.length)
  } else {
    if (decoded !== 'important') return
    let bang = priorityStart - 1
    while (bang >= 0 && isTrivia(nodes[bang]!)) bang -= 1
    if (nodes[bang]?.type !== 'word' || nodes[bang]?.value !== '!') return
    nodes.splice(bang, nodes.indexOf(priority.nodes.at(-1)!) - bang + 1)
  }
  declaration.value = valueParser.stringify(nodes).trimEnd()
  declaration.important = true
}

/** Strip authored paint while preserving the declaration's layout tokens. */
function normalizeDeclaration(declaration: Declaration): void {
  preserveEscapedImportant(declaration)
  const property = decodeCssIdentifier(declaration.prop).toLowerCase()
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
        const tokens = backgroundTokens(nodes)
        const kept = tokens
          .filter((token) => {
            if (token.type === 'function')
              return ['url', 'calc', 'min', 'max', 'clamp', 'env'].includes(
                decodeCssIdentifier(token.value).toLowerCase(),
              )
            if (token.type !== 'word') return token.type === 'div' || token.type === 'space'
            const identifier = decodeCssIdentifier(token.value).toLowerCase()
            return (
              BACKGROUND_LAYOUT_WORDS.has(identifier) ||
              /^[-+]?(?:\d*\.)?\d+(?:%|[a-z]+)?$/i.test(identifier)
            )
          })
          .flatMap((token) => token.nodes)
        const hadGradient = tokens.some(
          (token) =>
            token.type === 'function' &&
            decodeCssIdentifier(token.value).toLowerCase().endsWith('-gradient'),
        )
        const hasUrl = backgroundTokens(kept).some(
          (token) =>
            token.type === 'function' && decodeCssIdentifier(token.value).toLowerCase() === 'url',
        )
        if (hadGradient && !hasUrl) kept.unshift(valueParser('none').nodes[0]!)
        const layer = valueParser.stringify(kept).trim()
        // A color-only layer still resets the matching image layer. In
        // particular, `background: white` must not expose an older image.
        return layer || 'none'
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
        const images = backgroundTokens(nodes).flatMap((token): valueParser.Node[] => {
          if (token.type !== 'function') return []
          if (decodeCssIdentifier(token.value).toLowerCase() === 'url') return token.nodes
          if (decodeCssIdentifier(token.value).toLowerCase().endsWith('-gradient'))
            return [valueParser('none').nodes[0]!]
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
