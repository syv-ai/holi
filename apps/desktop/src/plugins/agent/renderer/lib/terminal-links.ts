/**
 * Vault paths in a terminal's output, as links that open the file in a pane
 * (docs/features/agent-sessions.md, The session view).
 *
 * Only a path the vault has is a link: a word that looks like a path but
 * names nothing stays text. An absolute path inside the clone counts as its
 * vault path; a `:12` after it (a line, as agents print them) is not part of
 * the path. No other text is read.
 */

import { pathBelowRoot, vaultPathIndex, type VaultPathIndex } from '@holi/shared'

export interface PathLink {
  /** Its vault-relative path. */
  path: string
  /** Where it is in the line: 0-based start, end exclusive. */
  start: number
  end: number
}

/** A path-shaped word: dot, slash and word characters, with an extension. */
const CANDIDATE = /(?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@.+-]+\.[A-Za-z0-9]{1,10}/g

/** The same on Windows: either slash, and a drive (`C:\`, `C:/`, or Git Bash's
 *  `/c/`) ahead of the folders. */
const WINDOWS_CANDIDATE =
  /(?:[A-Za-z]:[\\/]|\/[A-Za-z]\/|\.{0,2}[\\/])?(?:[\w@.+-]+[\\/])*[\w@.+-]+\.[A-Za-z0-9]{1,10}/g

/** A clone on a drive: the vault's own path says it is Windows, since a plugin's
 *  renderer is given no platform by `@/plugin-api`. */
const WINDOWS_ROOT = /^[A-Za-z]:[\\/]/

/** Git Bash's `/c/Users` as `C:/Users`. */
const msysDrive = (path: string): string =>
  path.replace(/^\/([A-Za-z])\//, (_, drive: string) => `${drive.toUpperCase()}:/`)

/** How many spaces a rooted name is tried at, so a long line costs a few lookups. */
const MAX_STOPS = 8

/** Where a name may end though it could go on: after a space, or before the
 *  punctuation a sentence or a quote puts after one. */
const MAY_END_A_NAME = /[ ),;'\]]/

/** A character no Windows file name holds: a name stops there. */
const NOT_IN_A_NAME = /[<>:"|?*]/

/** What the Windows lookup of a vault's paths is built from, kept per set of
 *  paths so a hover does not rebuild it. */
const indexes = new WeakMap<ReadonlySet<string>, VaultPathIndex>()

/** The index `vaultLinks` folds a Windows path's case through, for a vault at
 *  `root` that has `paths`; undefined for a root that is not on a drive, where
 *  a name is read exactly. */
export function windowsIndex(
  paths: ReadonlySet<string>,
  root: string | null,
): VaultPathIndex | undefined {
  if (root === null || !WINDOWS_ROOT.test(root)) return undefined
  let index = indexes.get(paths)
  if (!index) {
    index = vaultPathIndex(paths, 'win32')
    indexes.set(paths, index)
  }
  return index
}

/** The vault paths in `line`, for a vault at `root` that has `has`. A Windows
 *  root reads Windows paths: backslashes, a drive in either case, and a path
 *  that names a drive other than the vault's is never a vault file. `index`
 *  (from `windowsIndex`) gives a Windows path the spelling the vault has. */
export function vaultLinks(
  line: string,
  has: (path: string) => boolean,
  root: string | null,
  index?: VaultPathIndex,
): PathLink[] {
  const windows = root !== null && WINDOWS_ROOT.test(root)
  const pattern = windows ? WINDOWS_CANDIDATE : CANDIDATE
  const slashed = (text: string): string => (windows ? text.replaceAll('\\', '/') : text)
  const clone = root === null ? null : slashed(root)
  const out: PathLink[] = []
  /** `text` as the vault path it names, in the vault's spelling; null when the
   *  vault does not have it. */
  const resolve = (text: string): string | null => {
    const below = root === null ? null : pathBelowRoot(root, text, windows ? 'win32' : 'posix')
    let path = below ?? (windows ? msysDrive(slashed(text)) : text)
    if (below === null && path.startsWith('./')) path = path.slice(2)
    if (path.startsWith('/') || path.startsWith('../')) return null
    path = (windows && index?.get(path.toLowerCase())) || path
    return has(path) ? path : null
  }
  // The clone's own path may hold a space (`C:\Users\Ada Lovelace\Holi\…`), which
  // no path-shaped word does: find it by the clone's name, then the rest after it.
  const rooted: { 0: string; index: number }[] = []
  if (windows && clone !== null) {
    // In the clone's own spelling and in Git Bash's (`/c/Users/…` for `C:/Users/…`).
    const spelled = (path: string) =>
      path
        .replace(/\/+$/, '')
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replaceAll('/', '[\\\\/]')
    const top = `(?:${spelled(clone)}|${spelled(`/${clone[0]}${clone.slice(2)}`)})`
    const tail = String.raw`[\\/](?:[\w@.+-]+[\\/])*[\w@.+-]+\.[A-Za-z0-9]{1,10}`
    // A name past the clone may hold spaces, which no path-shaped word does:
    // the line's rest is tried at each place the name could stop, longest first,
    // and the longest that is a file the vault has wins.
    for (const hit of line.matchAll(new RegExp(`${top}[\\\\/]`, 'gi'))) {
      const from = hit.index + hit[0].length
      const stops: number[] = []
      for (let i = from; stops.length <= MAX_STOPS; i++) {
        if (i >= line.length || NOT_IN_A_NAME.test(line[i]!)) {
          stops.push(i)
          break
        }
        if (MAY_END_A_NAME.test(line[i]!)) stops.push(i)
      }
      const longest = stops
        .reverse()
        .map((stop) => line.slice(hit.index, stop))
        .find((text) => /\.[A-Za-z0-9]{1,10}$/.test(text) && resolve(text) !== null)
      if (longest !== undefined) rooted.push({ 0: longest, index: hit.index })
    }
    // What has no space in it, as before: a name followed by punctuation.
    for (const m of line.matchAll(new RegExp(top + tail, 'gi'))) {
      if (!rooted.some((r) => r.index === m.index)) rooted.push(m)
    }
  }
  const free = [...line.matchAll(pattern)].filter(
    (m) => !rooted.some((r) => m.index < r.index + r[0].length && r.index < m.index + m[0].length),
  )
  for (const match of [...rooted, ...free].sort((a, b) => a.index - b.index)) {
    const text = match[0]
    const start = match.index
    // Part of a longer token (`foo.md` inside `xfoo.md`) is not a path.
    if (start > 0 && (windows ? /[\w/\\]/ : /[\w/]/).test(line[start - 1]!)) continue
    const path = resolve(text)
    if (path !== null) out.push({ path, start, end: start + text.length })
  }
  return out
}
