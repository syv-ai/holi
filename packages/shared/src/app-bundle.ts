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
import { isAppPrivatePath } from './app-store'
import {
  AGENT_SURFACE_FILES,
  isAgentSurfacePath,
  isHiddenPath,
  isLocalOnlyPath,
  isMachineStatePath,
  isSecretPath,
  vaultRelPath,
} from './path-safety'

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

/** The names Claude Code reads instructions from, in any folder it works in. */
const AGENT_INSTRUCTION_NAMES = new Set(['agents.md', 'claude.md'])
const AGENT_SURFACE_NAMES = new Set(AGENT_SURFACE_FILES.map((f) => f.toLowerCase()))

/**
 * May a vault app write `path`? The one write rule for app code, whichever
 * door it comes through; `path` is already normalised (`vaultRelPath`), and
 * whether the app may read it is the caller's own fence.
 *
 * Never anything hidden (`.holi/`, `.claude/`, `.github/`: configuration and
 * machinery, each with its own writer, and with it machine state, the agent
 * surface and secret files), anything local (`.local.`: one person's, which an
 * app's code must not change for them, and which never syncs to show anyone it
 * did), anything inside an app's bundle (another app's code, or records, which
 * have the store), or an `AGENTS.md` or `CLAUDE.md` at any depth and in any
 * case (Claude Code loads the one in a subfolder it works in, so an app that
 * planted one would be instructing the agent; `claude.md` opens `CLAUDE.md` on
 * macOS). What is left is the vault's shared content, which an app writes as
 * any member's editor would.
 */
export function isAppWritablePath(path: string): boolean {
  return isSharedContentPath(path) && appBundleOf(path) === null
}

/**
 * `isAppWritablePath` without the bundle rule: the vault's shared content,
 * an app's own bundle included. What anything written for the vault by a
 * process Holi does not trust (a vault app, an agent's unwatched job) may
 * land on; `path` is already normalised.
 */
export function isSharedContentPath(path: string): boolean {
  return !(
    isHiddenPath(path) ||
    isLocalOnlyPath(path) ||
    isSecretPath(path) ||
    isMachineStatePath(path) ||
    isAgentSurfacePath(path) ||
    AGENT_SURFACE_NAMES.has(path.toLowerCase()) ||
    path.split('/').some((seg) => AGENT_INSTRUCTION_NAMES.has(seg.toLowerCase()))
  )
}

/**
 * Is a normalised vault path one no app may reach: the agent surface, this
 * machine's state under `.holi/state/` (it holds the bridge's tokens), a
 * secret file (an app gets only the keys it declares, through `holi.env`), or
 * any app's records and log. The bridge's reads refuse these, and an app's
 * slash command is not offered in a note that is one, since it would be given
 * the note's text (nor where `isAppWritablePath` refuses, since its answer is
 * written into the note).
 */
export function isAppFencedPath(path: string): boolean {
  if (isAgentSurfacePath(path) || isMachineStatePath(path) || isSecretPath(path)) return true
  const bundle = appBundleOf(path)
  return bundle !== null && isAppPrivatePath(path.slice(bundle.length + 1))
}
