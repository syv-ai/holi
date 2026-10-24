/**
 * A web page's preview: what it says about itself in its `<head>`, the
 * `og:` tags first (docs/features/links.md).
 *
 * Fetched by main with Node's own `fetch`, never Electron's session, so no
 * cookie and no sign-in goes with it: a page behind a login answers with its
 * login page, which names nothing worth showing, and the card is the address
 * alone. Only the head is read, and only so much of it. An address inside
 * this machine's network is never fetched: a hover is all it takes, and the
 * address may be in a note someone else wrote.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { decodeHTML } from 'entities'
import { Parser } from 'htmlparser2'
import { hostOf, isWebUrl, type LinkPreview } from '../shared/preview'

/** How long a page has to answer, and how much of it is read. */
const TIMEOUT_MS = 5_000
const MAX_BYTES = 1_000_000
const MAX_REDIRECTS = 5

/** The preview `html`, fetched from `url`, says it has. Relative addresses
 *  resolve against `url`, the address the page came from after redirects. */
export function parseHead(html: string, url: string): Omit<LinkPreview, 'url'> {
  const meta = new Map<string, string>()
  let title = ''
  let inTitle = false
  let icon: string | undefined
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === 'title') inTitle = true
        if (name === 'meta') {
          const key = (attrs['property'] ?? attrs['name'] ?? '').toLowerCase()
          const content = attrs['content']?.trim()
          // The first of a key wins, as it does for the sites that read them.
          if (key !== '' && content !== undefined && content !== '' && !meta.has(key)) {
            meta.set(key, content)
          }
        }
        if (name === 'link' && icon === undefined && attrs['href'] !== undefined) {
          const rel = (attrs['rel'] ?? '').toLowerCase().split(/\s+/)
          if (rel.includes('icon')) icon = attrs['href']
        }
        // The body is not read: everything a preview needs is above it.
        if (name === 'body') parser.pause()
      },
      ontext(text) {
        if (inTitle) title += text
      },
      onclosetag(name) {
        if (name === 'title') inTitle = false
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  )
  parser.write(html)
  parser.end()

  const absolute = (href: string | undefined): string | undefined => {
    if (href === undefined) return undefined
    try {
      const resolved = new URL(href, url).href
      return isWebUrl(resolved) ? resolved : undefined
    } catch {
      return undefined
    }
  }
  const text = (s: string | undefined): string | undefined => {
    // Some sites (GitHub's descriptions) escape their text twice, so one
    // decoding still reads `&#39;`: decode what is left once more.
    const decoded = s !== undefined && /&(#\d+|#x[\da-f]+|[a-z]+\d*);/i.test(s) ? decodeHTML(s) : s
    const t = decoded?.replace(/\s+/g, ' ').trim()
    return t === undefined || t === '' ? undefined : t
  }
  const found = {
    title: text(meta.get('og:title') ?? meta.get('twitter:title') ?? title),
    description: text(
      meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'),
    ),
    image: absolute(meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image')),
    siteName: text(meta.get('og:site_name')) ?? hostOf(url),
    icon: absolute(icon ?? '/favicon.ico'),
  }
  return Object.fromEntries(Object.entries(found).filter(([, v]) => v !== undefined)) as Omit<
    LinkPreview,
    'url'
  >
}

/** The text of a response's head: read until `</head>` or `MAX_BYTES`, in
 *  the charset the response names. */
async function readHead(response: Response): Promise<string> {
  const charset = /charset=([^;]+)/i.exec(response.headers.get('content-type') ?? '')?.[1]
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charset?.trim() ?? 'utf-8')
  } catch {
    decoder = new TextDecoder('utf-8')
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  let html = ''
  let bytes = 0
  try {
    while (bytes < MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      html += decoder.decode(value, { stream: true })
      if (/<\/head>|<body[\s>]/i.test(html)) break
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
  return html
}

/** Whether an address resolves into this machine or its network: loopback,
 *  private, link-local (the cloud metadata address among them), carrier NAT
 *  and their IPv6 twins. Such a page is never fetched. */
const LOCAL = (() => {
  const list = new BlockList()
  for (const [net, bits] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
  ] as const) {
    list.addSubnet(net, bits, 'ipv4')
  }
  list.addAddress('::', 'ipv6')
  list.addAddress('::1', 'ipv6')
  list.addSubnet('fc00::', 7, 'ipv6')
  list.addSubnet('fe80::', 10, 'ipv6')
  return list
})()

/** Every address a host name resolves to. */
export type Resolve = (host: string) => Promise<string[]>

const resolveHost: Resolve = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

/** Whether `url`'s host is reachable only from inside this machine's network. */
async function isLocal(url: string, resolve: Resolve): Promise<boolean> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) === 0 ? await resolve(host) : [host]
  return addresses.some((a) => {
    // An IPv4 address written as IPv6 (`::ffff:127.0.0.1`) is checked as the
    // IPv4 one it is.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a)?.[1]
    if (mapped !== undefined) return LOCAL.check(mapped, 'ipv4')
    return LOCAL.check(a, isIP(a) === 6 ? 'ipv6' : 'ipv4')
  })
}

/** A preview, and whether it is worth keeping: one that failed for a reason
 *  that may pass (offline, a timeout, the site's own error) is asked again
 *  next time rather than kept for a day. */
export interface Fetched {
  preview: LinkPreview
  keep: boolean
}

/**
 * `url`'s preview. Never throws: a page that cannot be read (a timeout, a
 * refusal, not HTML) is the address alone, with its host as the site.
 * Redirects are followed by hand, at most `MAX_REDIRECTS`, and every hop is
 * held to the same rules as the first: a web address, outside this machine's
 * network.
 */
export async function fetchPreview(
  url: string,
  fetchImpl: typeof fetch = fetch,
  resolve: Resolve = resolveHost,
): Promise<Fetched> {
  const bare: LinkPreview = { url, siteName: hostOf(url) }
  if (!isWebUrl(url)) return { preview: bare, keep: true }
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  try {
    let at = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isWebUrl(at) || (await isLocal(at, resolve))) return { preview: bare, keep: true }
      const response = await fetchImpl(at, {
        redirect: 'manual',
        signal,
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Holi link preview' },
      })
      const next = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && next !== null) {
        void response.body?.cancel().catch(() => {})
        at = new URL(next, at).href
        continue
      }
      const type = response.headers.get('content-type') ?? ''
      if (!response.ok || !/text\/html|application\/xhtml/i.test(type)) {
        void response.body?.cancel().catch(() => {})
        // A login wall (401, 403) is lasting; the site's own trouble is not.
        return { preview: bare, keep: response.status < 500 && response.status !== 429 }
      }
      return { preview: { ...parseHead(await readHead(response), at), url }, keep: true }
    }
    return { preview: bare, keep: true }
  } catch {
    return { preview: bare, keep: false }
  }
}
