/** Small, pure path helpers for the file tree. Vault paths are POSIX-style
 *  ('/'-separated), relative to the vault root. */

export const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export const parentOf = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export const joinPath = (parent: string, name: string): string =>
  parent ? `${parent}/${name}` : name

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
 *  Duplicate). Collision is asked of `taken`, so it works for a file (suffix
 *  before the extension) and a folder (suffix on the bare name) alike. */
export const freeCopyPath = (taken: (p: string) => boolean, path: string): string => {
  if (!taken(path)) return path
  const base = basename(path)
  const dir = parentOf(path)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let n = 1; n < 1000; n++) {
    const candidate = joinPath(dir, `${stem}${n === 1 ? ' copy' : ` copy ${n}`}${ext}`)
    if (!taken(candidate)) return candidate
  }
  return path
}
