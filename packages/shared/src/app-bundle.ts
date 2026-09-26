/**
 * What makes a directory a vault app (D107).
 *
 * An app is a **bundle**: a directory whose name ends in `.app`, anywhere in the
 * vault, holding `index.html` and `app.yaml`. Like a note, it is identified by
 * its vault-relative path (`Finance/Budget.app`); there is no separate id.
 *
 * Browser-safe: the renderer, main and the tests all read these.
 */
import { isAgentSurfacePath, vaultRelPath } from './path-safety'

export const APP_SUFFIX = '.app'

const isBundleName = (segment: string): boolean =>
  segment.length > APP_SUFFIX.length && segment.endsWith(APP_SUFFIX)

/**
 * Is `path` an app bundle?
 *
 * Not on the agent surface (D74: an app there could rewrite the agent's own
 * hooks), and not inside another bundle: an app inside an app is just files of
 * the outer one, or the outer app could serve the inner one's code as its own.
 */
export function isAppBundlePath(path: string): boolean {
  let normalized: string
  try {
    normalized = vaultRelPath(path)
  } catch {
    return false
  }
  if (normalized !== path) return false
  const segments = path.split('/')
  if (!isBundleName(segments[segments.length - 1]!)) return false
  if (segments.slice(0, -1).some(isBundleName)) return false
  return !isAgentSurfacePath(`${path}/`)
}

/** The bundle a file belongs to, or null. Only its directories count: a file
 *  named `x.app` is a file. */
export function appBundleOf(filePath: string): string | null {
  const segments = filePath.split('/')
  for (let i = 1; i < segments.length; i++) {
    const prefix = segments.slice(0, i).join('/')
    if (isBundleName(segments[i - 1]!)) return isAppBundlePath(prefix) ? prefix : null
  }
  return null
}

/** What the app is called: its folder name without `.app`, as a note drops `.md`. */
export function appName(bundle: string): string {
  return bundle.slice(bundle.lastIndexOf('/') + 1, -APP_SUFFIX.length)
}

/** DNS allows 63; any fixed width under it will do. */
const LABEL = 60
const HOST_TAIL = '.app'

/**
 * The `holi-app://` host for a bundle: its path's UTF-8 bytes in hex, in
 * dot-joined labels, then a fixed `app` label.
 *
 * A path cannot be a host (slashes, case folding), and encoding it rather than
 * hashing it means main decodes the host straight back to the bundle, with no
 * lookup and no collisions. The fixed last label is load-bearing: URL parsers
 * read a host whose last label is numeric as IPv4, and `41` is valid hex.
 */
export function appHost(bundle: string): string {
  let hex = ''
  for (const byte of new TextEncoder().encode(bundle)) hex += byte.toString(16).padStart(2, '0')
  const labels: string[] = []
  for (let i = 0; i < hex.length; i += LABEL) labels.push(hex.slice(i, i + LABEL))
  return `${labels.join('.')}${HOST_TAIL}`
}

/** `appHost`'s inverse, or null for a host that is not one or does not decode
 *  to a bundle. Hosts arrive case-folded, and hex is lowercase already. */
export function bundleFromAppHost(host: string): string | null {
  const lower = host.toLowerCase()
  if (!lower.endsWith(HOST_TAIL)) return null
  const hex = lower.slice(0, -HOST_TAIL.length).split('.').join('')
  if (hex === '' || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  let path: string
  try {
    path = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  return isAppBundlePath(path) ? path : null
}
