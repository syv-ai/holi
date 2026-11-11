/**
 * Vault paths in a terminal's output, as links that open the file in a pane
 * (docs/features/agent-sessions.md, The session view).
 *
 * Only a path the vault has is a link: a word that looks like a path but
 * names nothing stays text. An absolute path inside the clone counts as its
 * vault path; a `:12` after it (a line, as agents print them) is not part of
 * the path. No other text is read.
 */

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

/** A clone on a drive: the vault's own path says it is Windows, since this
 *  renderer has no other way to know where its main process runs. */
const WINDOWS_ROOT = /^[A-Za-z]:[\\/]/

/** Git Bash's `/c/Users` as `C:/Users`. */
const msysDrive = (path: string): string =>
  path.replace(/^\/([A-Za-z])\//, (_, drive: string) => `${drive.toUpperCase()}:/`)

/** The vault paths in `line`, for a vault at `root` that has `has`. A Windows
 *  root reads Windows paths: backslashes, a drive in either case, and a path
 *  that names a drive other than the vault's is never a vault file. */
export function vaultLinks(
  line: string,
  has: (path: string) => boolean,
  root: string | null,
): PathLink[] {
  const windows = root !== null && WINDOWS_ROOT.test(root)
  const pattern = windows ? WINDOWS_CANDIDATE : CANDIDATE
  const slashed = (text: string): string => (windows ? text.replaceAll('\\', '/') : text)
  const folded = (text: string): string => (windows ? text.toLowerCase() : text)
  const clone = root === null ? null : slashed(root)
  const prefix = clone === null ? null : clone.endsWith('/') ? clone : `${clone}/`
  const out: PathLink[] = []
  // The clone's own path may hold a space (`C:\Users\Ada Lovelace\Holi\…`), which
  // no path-shaped word does: find it by the clone's name, then the rest after it.
  const rooted: { 0: string; index: number }[] = []
  if (windows && clone !== null) {
    const top = clone
      .replace(/\/+$/, '')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replaceAll('/', '[\\\\/]')
    const tail = '[\\\\/](?:[\\w@.+-]+[\\\\/])*[\\w@.+-]+\\.[A-Za-z0-9]{1,10}'
    rooted.push(...line.matchAll(new RegExp(top + tail, 'gi')))
  }
  const free = [...line.matchAll(pattern)].filter(
    (m) => !rooted.some((r) => m.index < r.index + r[0].length && r.index < m.index + m[0].length),
  )
  for (const match of [...rooted, ...free].sort((a, b) => a.index - b.index)) {
    const text = match[0]
    const start = match.index
    // Part of a longer token (`foo.md` inside `xfoo.md`) is not a path.
    if (start > 0 && (windows ? /[\w/\\]/ : /[\w/]/).test(line[start - 1]!)) continue
    let path = windows ? msysDrive(slashed(text)) : text
    if (prefix !== null && folded(path).startsWith(folded(prefix))) path = path.slice(prefix.length)
    else if (path.startsWith('./')) path = path.slice(2)
    if (path.startsWith('/') || path.startsWith('../') || !has(path)) continue
    out.push({ path, start, end: start + text.length })
  }
  return out
}
