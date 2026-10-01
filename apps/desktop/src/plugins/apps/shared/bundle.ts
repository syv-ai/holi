/**
 * What an app is called, and the `holi-app:` host that names its bundle.
 *
 * Browser-safe: the renderer, main and the tests all read these.
 */
import { appSuffix, isAppBundlePath } from '@holi/shared'

/** What the app is called: its folder name without `.app` (or `.local.app`),
 *  as a note drops `.md`. */
export function appName(bundle: string): string {
  return bundle.slice(bundle.lastIndexOf('/') + 1, -appSuffix(bundle).length)
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
