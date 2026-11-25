import { isIP } from 'node:net'
import { posix } from 'node:path'
import { MAX_MDX_SPECIFIER_LENGTH } from '@holi/shared'

const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Consent keys are exact canonical HTTPS origins: lowercase DNS name, no port or slash. */
export function isMdxExternalOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('https://')) return false
  const host = value.slice('https://'.length)
  if (
    host.length > 253 ||
    /[^a-z0-9.-]/.test(host) ||
    !DNS_NAME.test(host) ||
    isIP(host) ||
    /\.(?:localhost|local|internal|onion)$|(?:^|\.)home\.arpa$/.test(host)
  )
    return false
  try {
    return new URL(value).origin === value
  } catch {
    return false
  }
}

/** Validate a raw import or redirect before authorization or canonical graph deduplication.
 * A relative destination requires the already vetted URL of the enclosing module or hop.
 */
export function resolveMdxExternalModule(
  raw: string,
  base?: URL,
): { url: URL; format: 'js' | 'jsx' } | { error: 'unsafe-url' | 'unsupported-format' } {
  const url = parseDestination(raw, base)
  if (!url) return { error: 'unsafe-url' }
  const format = moduleFormat(url.pathname)
  return format ? { url, format } : { error: 'unsupported-format' }
}

function parseDestination(raw: string, base?: URL): URL | null {
  // WHATWG URL silently repairs backslashes, missing slashes and control characters.
  if (!raw || raw.length > MAX_MDX_SPECIFIER_LENGTH || /[\s\\\u0000-\u001f\u007f]/u.test(raw))
    return null
  const input = base && raw.startsWith('//') ? `https:${raw}` : raw
  const absolute = !base || /^[a-z][a-z\d+.-]*:/i.test(input)
  let origin = base?.origin
  if (absolute) {
    const authority = /^https:\/\/([^/?#]+)/i.exec(input)?.[1]
    const host = authority?.replace(/:443$/, '')
    if (!host || /[^a-zA-Z0-9.-]/.test(host)) return null
    origin = `https://${host.toLowerCase()}`
  }
  if (!isMdxExternalOrigin(origin)) return null
  try {
    const url = new URL(input, base)
    if (url.origin !== origin || url.username || url.password) return null
    url.hash = ''
    return url.href.length <= MAX_MDX_SPECIFIER_LENGTH ? url : null
  } catch {
    return null
  }
}

function moduleFormat(pathname: string): 'js' | 'jsx' | null {
  let path: string
  try {
    // Decode suffixes for the format check, but don't guess how a server handles
    // encoded separators, controls, or another layer of percent encoding.
    if (/%2f/i.test(pathname)) return null
    path = decodeURIComponent(pathname)
    if (/[\\%\u0000-\u001f\u007f]/u.test(path)) return null
  } catch {
    return null
  }
  const file = posix.basename(path)
  if (/\.jsx$/i.test(file)) return 'jsx'
  if (/\.m?js$/i.test(file)) return 'js'
  // Extensionless routes and numeric semver pins (e.g. /pkg@1.2.3) are CDN
  // module entry points. Other dotted suffixes are not module formats.
  if (!file.includes('.') || /^[a-z\d_-]+@\d+\.\d+\.\d+$/i.test(file)) return 'js'
  return null
}
