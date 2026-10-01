import { readFile } from 'node:fs/promises'
import { vaultRelPath } from '@holi/shared'
import type { PluginScheme } from '../plugin-api'
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

/**
 * `holi-vault://vault/<vaultRelPath>`: the open vault's files, read-only, for
 * the renderer's `<img>`. `standard` so URLs parse with a host and a path;
 * `secure`, `supportFetchAPI` and `stream` so `<img>` and fetch treat it like
 * https and can stream large files.
 *
 * Resolving against the open vault (not a remote in the URL) is safe: there
 * is exactly one, and a vault switch resets the workspace, so the open note is
 * always in it.
 */
export const vaultScheme: PluginScheme = {
  scheme: 'holi-vault',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  async handle(request, ctx) {
    const vault = ctx.active()
    if (vault === null) return new Response(null, { status: 404 })
    const abs = assetAbsPath(vault.root, request.url)
    if (abs === null) return new Response(null, { status: 403 })
    try {
      const bytes = await readFile(abs)
      return new Response(bytes, { headers: { 'content-type': mimeFor(abs) } })
    } catch {
      return new Response(null, { status: 404 })
    }
  },
}
