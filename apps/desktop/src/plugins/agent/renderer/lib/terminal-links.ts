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

/** The vault paths in `line`, for a vault at `root` that has `has`. */
export function vaultLinks(
  line: string,
  has: (path: string) => boolean,
  root: string | null,
): PathLink[] {
  const out: PathLink[] = []
  const prefix = root === null ? null : root.endsWith('/') ? root : `${root}/`
  for (const match of line.matchAll(CANDIDATE)) {
    const text = match[0]
    const start = match.index
    // Part of a longer token (`foo.md` inside `xfoo.md`) is not a path.
    if (start > 0 && /[\w/]/.test(line[start - 1]!)) continue
    let path = text
    if (prefix !== null && path.startsWith(prefix)) path = path.slice(prefix.length)
    else if (path.startsWith('./')) path = path.slice(2)
    if (path.startsWith('/') || path.startsWith('../') || !has(path)) continue
    out.push({ path, start, end: start + text.length })
  }
  return out
}
