/** Small, pure path helpers for the file tree. Vault paths are POSIX-style
 *  ('/'-separated), relative to the vault root. */

export const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export const parentOf = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export const joinPath = (parent: string, name: string): string =>
  parent ? `${parent}/${name}` : name

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
