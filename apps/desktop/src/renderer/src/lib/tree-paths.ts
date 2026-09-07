/** Small, pure path helpers for the file tree. Vault paths are POSIX-style
 *  ('/'-separated), relative to the vault root. */

export const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export const parentOf = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export const joinPath = (parent: string, name: string): string =>
  parent ? `${parent}/${name}` : name

/**
 * Every folder between the vault root and `path`, outermost first.
 *
 * Outermost first matters: expanding a tree walks down, and a child cannot be
 * expanded before its parent has been. The path itself is not included — it is
 * the thing being revealed, not a folder on the way — and neither is the root,
 * which is not addressed by a path.
 */
export const ancestorsOf = (path: string): string[] => {
  const segments = path.split('/')
  segments.pop()
  return segments.map((_, i) => segments.slice(0, i + 1).join('/'))
}

/** A New File / rename name, defaulted to markdown. The vault is mostly markdown,
 *  so a bare name becomes a note (`note` → `note.md`); but a typed extension is
 *  kept literally — the vault holds arbitrary files now, so `hello.json` is a real
 *  JSON file, not a coerced note (spec §Arbitrary files). */
export const withMdExtension = (name: string): string =>
  /\.[^./]+$/.test(name) ? name : `${name}.md`

/** The [start, end] of the basename minus its extension — what a rename input
 *  should pre-select so the user edits the name, not the `.md` (VS Code). */
export const renameBasenameRange = (name: string): [number, number] => {
  const dot = name.lastIndexOf('.')
  return [0, dot > 0 ? dot : name.length]
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

/** True if `path` is occupied as a file OR as a folder prefix among `paths`. */
export const pathTaken = (paths: Iterable<string>, path: string): boolean => {
  for (const p of paths) if (p === path || p.startsWith(`${path}/`)) return true
  return false
}

/** The first non-colliding `… copy` / `… copy N` name for `path` (VS Code's
 *  Duplicate). Re-exported so the tree's own imports stay local; the rule now
 *  lives in `@holi/shared` because main applies it too, to a real directory on
 *  disk (`export-files.ts`), and the two must pick the same names. */
export { freeCopyPath } from '@holi/shared'
