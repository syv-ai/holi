/**
 * The `holi-app://` scheme — how one vault app's files reach its frame.
 *
 * `holi-vault://` serves the whole vault to the renderer, which is trusted. This
 * one is deliberately narrower: an app is served **from its own directory and
 * nowhere else**, so the URL's host is the app id and the resolved root is
 * `<vaultRoot>/.holi/apps/<appId>`. One app cannot read another's files, and no
 * app can read a note off disk — the bridge is the only route to vault content,
 * and the bridge is where the refusals live.
 *
 * Everything here is pure; the `protocol.handle` that calls it stays in
 * `index.ts` beside the vault one, so the two handlers read as the pair they are.
 */
import { join } from 'node:path'
import { APPS_DIR, isValidAppId, vaultRelPath } from '@holi/shared'
import { absPathFor } from '../vault/vault-files'
import { mimeFor } from '../vault/asset-protocol'

/**
 * `holi-app://<appId>/<rel>` → its parts, or null when the scheme is wrong, the
 * URL is unparseable, or the id is not one an app may have.
 *
 * A bare host (`holi-app://retro`) means the entry document, the same way a web
 * server resolves `/` to `index.html`.
 *
 * **The host is folded to lower case explicitly.** Chromium folds the host of a
 * `standard:` scheme; Node's `URL` leaves a non-special scheme's host alone. The
 * fold here makes the two agree, so `isValidAppId` sees the same string in the
 * running app as it does in a test — and the folding is an intended rule rather
 * than a property of whichever parser happened to run.
 */
export function parseAppUrl(url: string): { appId: string; rel: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'holi-app:') return null
  const appId = parsed.hostname.toLowerCase()
  if (!isValidAppId(appId)) return null
  let rel: string
  try {
    rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
  } catch {
    return null
  }
  return { appId, rel: rel === '' ? 'index.html' : rel }
}

/**
 * Absolute path for one file inside ONE app's directory, or null when it would
 * escape.
 *
 * Two guards compose exactly as `assetAbsPath`'s do: the URL parser has already
 * normalized any raw `../` away (clamped to the host root), and `vaultRelPath`
 * rejects the residue — an absolute path, an empty one, or a surviving `..`.
 * The root it joins under is the app's own directory, which is the difference
 * that matters.
 */
export function appFileAbsPath(vaultRoot: string, appId: string, rel: string): string | null {
  if (!isValidAppId(appId)) return null
  try {
    return absPathFor(join(vaultRoot, APPS_DIR, appId), vaultRelPath(rel))
  } catch {
    return null
  }
}

/**
 * Content-type for a file inside an app.
 *
 * `mimeFor` is the vault asset map — images and PDFs, because that is all
 * `holi-vault://` ever serves. An app is a web page, so the web types are added
 * *here* rather than there: widening the shared map would make every `.html`
 * anywhere in the vault renderable on the trusted `holi-vault://` origin, which
 * is precisely the reach this scheme exists to avoid.
 */
const APP_MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
}

export function appMimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return APP_MIME[ext] ?? mimeFor(path)
}
