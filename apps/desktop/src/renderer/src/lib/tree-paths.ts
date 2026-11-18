/** Small, pure path helpers for the file tree. Vault paths are POSIX-style
 *  ('/'-separated), relative to the vault root. */

export const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export const parentOf = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export const joinPath = (parent: string, name: string): string =>
  parent ? `${parent}/${name}` : name

/** An absolute Windows path: a drive (`C:\` or `C:/`) or a UNC share. Nothing
 *  a POSIX path starts with, so the path itself says which OS wrote it. */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/

/** The file name of an absolute path the OS handed over (a drop): after the
 *  last backslash or slash on Windows, after the last slash elsewhere. */
export const sourceName = (source: string): string =>
  WINDOWS_PATH.test(source)
    ? source.slice(Math.max(source.lastIndexOf('\\'), source.lastIndexOf('/')) + 1)
    : basename(source)

/** The vault path of `source`, an absolute path inside the vault at `root`, or
 *  null when it is outside (or is the vault itself). Windows compares with
 *  either separator and without regard to case. */
export const sourceInside = (root: string, source: string): string | null => {
  const windows = WINDOWS_PATH.test(source)
  const slashed = (path: string) => (windows ? path.replaceAll('\\', '/') : path)
  const folded = (path: string) => (windows ? path.toLowerCase() : path)
  const top = slashed(root)
  const prefix = top.endsWith('/') ? top : `${top}/`
  const here = slashed(source)
  if (!folded(here).startsWith(folded(prefix))) return null
  return here.length > prefix.length ? here.slice(prefix.length) : null
}

/** Every doc at or under `source`: a file matches itself; a folder matches its
 *  `source/` prefix. A folder move/delete fans out to exactly these. */
export const expandToFiles = (docPaths: string[], source: string): string[] =>
  docPaths.filter((p) => p === source || p.startsWith(`${source}/`))

/** `{ from, to }` for every doc under `source` such that `source` itself lands at
 *  `dest` — a file → `dest`, a folder → `dest/…` preserving nested structure. */
export const remapUnder = (
  docPaths: string[],
  source: string,
  dest: string,
): { from: string; to: string }[] =>
  expandToFiles(docPaths, source).map((from) => ({ from, to: dest + from.slice(source.length) }))
