/**
 * What makes a directory a vault app.
 *
 * An app is a **bundle**: a directory whose name ends in `.app`, anywhere in the
 * vault, holding `index.html` and `app.yaml`. Like a note, it is identified by
 * its vault-relative path (`Finance/Budget.app`); there is no separate id.
 *
 * Core keeps this grammar because a synced vault holds bundles whatever this
 * machine runs: the fences, the watcher and the `.local.app` rule read it.
 * The rest of what apps say is the apps plugin's (`src/plugins/apps/shared/`).
 *
 * Browser-safe: the renderer, main and the tests all read these.
 */
import { isAgentSurfacePath, vaultRelPath } from './path-safety'

export const APP_SUFFIX = '.app'

/** A personal app's suffix: the `.local.` marker keeps the folder, and so
 *  every file in it, on this machine (`isLocalOnlyPath`). */
export const LOCAL_APP_SUFFIX = '.local.app'

/** The suffix a bundle's name carries, which a rename must keep: renaming a
 *  personal `Home.local.app` to `Home.app` would publish it. */
export function appSuffix(bundle: string): string {
  return bundle.endsWith(LOCAL_APP_SUFFIX) ? LOCAL_APP_SUFFIX : APP_SUFFIX
}

const isBundleName = (segment: string): boolean =>
  segment.endsWith(APP_SUFFIX) && segment.length > appSuffix(segment).length

/**
 * Is `path` an app bundle?
 *
 * Not on the agent surface (an app there could rewrite the agent's own
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
