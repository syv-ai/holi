import { pathBelowRoot, type VaultPathIndex } from '@holi/shared'

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

/** Whether an absolute path an OS handed over is a Windows one. */
export const isWindowsPath = (path: string): boolean => WINDOWS_PATH.test(path)

/** The file name of an absolute path the OS handed over (a drop): after the
 *  last backslash or slash on Windows, after the last slash elsewhere. */
export const sourceName = (source: string): string =>
  WINDOWS_PATH.test(source)
    ? source.slice(Math.max(source.lastIndexOf('\\'), source.lastIndexOf('/')) + 1)
    : basename(source)

/** The vault path of `source`, an absolute path inside the vault at `root`, or
 *  null when it is outside (or is the vault itself). Windows compares with
 *  either separator and without regard to case; with `index` (the vault's own
 *  paths, built for the OS the sources came from) a path the vault has comes
 *  back in the vault's spelling, which is the one a move is planned by. */
export const sourceInside = (
  root: string,
  source: string,
  index?: VaultPathIndex,
): string | null => {
  const windows = WINDOWS_PATH.test(source)
  const rel = pathBelowRoot(root, source, windows ? 'win32' : 'posix')
  if (rel === null) return null
  return (windows && index?.get(rel.toLowerCase())) || rel
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
