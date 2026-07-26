import { vaultRelPath } from '@holi/shared'
import { absPathFor } from './vault-files'

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

/** Content-type from a path's extension; octet-stream when unknown. */
export function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME[ext] ?? 'application/octet-stream'
}

/**
 * Absolute file path for a `holi-vault://vault/<vaultRelPath>` request, or null
 * when the path is malformed or escapes the vault. Two guards compose: the URL
 * parser normalizes raw `../` (clamped to the host root), and `vaultRelPath`
 * rejects any residual `..` / absolute / empty path — the same boundary
 * `notes.read` enforces. `root` is the ACTIVE vault's root.
 */
export function assetAbsPath(root: string, requestUrl: string): string | null {
  let rel: string
  try {
    rel = decodeURIComponent(new URL(requestUrl).pathname).replace(/^\/+/, '')
  } catch {
    return null
  }
  try {
    return absPathFor(root, vaultRelPath(rel))
  } catch {
    return null
  }
}
