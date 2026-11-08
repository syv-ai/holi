/**
 * The " copy" / " copy 2" naming rule (VS Code's Duplicate), and the
 * " 2" / " 3" rule for a new file that must not replace one.
 *
 * The copy rule is shared because it is applied in two places that must agree: duplicating
 * inside the vault, and exporting to a folder on disk that already holds a file
 * of that name. Collision is asked of `taken` rather than of a filesystem, so
 * the same rule serves an in-memory path list and a real directory.
 *
 * Paths are '/'-separated: vault-relative in the renderer, POSIX absolute in
 * main. Holi is macOS-only, and `vaultRelPath` already refuses backslashes.
 */

/**
 * `path` split into its folder, stem and extension, the way both naming rules
 * suffix it.
 */
function splitName(path: string): { dir: string; stem: string; ext: string } {
  const slash = path.lastIndexOf('/')
  const base = path.slice(slash + 1)
  const dir = slash === -1 ? '' : path.slice(0, slash)
  /**
   * **A `.local.` marker counts as part of the extension**.
   *
   * Splitting on the last dot alone would turn `notes.local.md` into
   * `notes.local copy.md`, which no longer matches `*.local.*`, so duplicating
   * a personal file would publish it. The copy is `notes copy.local.md`. Fixed
   * here rather than by widening the marker: the marker is one exact spelling.
   */
  const localExt = /\.local\.[^.]+$/.exec(base)
  const dot = localExt !== null ? localExt.index : base.lastIndexOf('.')
  // `dot > 0`, not `dot >= 0`: a leading dot is a dotfile's name, not an
  // extension, so `.gitignore` must not become ' copy.gitignore'.
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  return { dir, stem, ext }
}

export const freeCopyPath = (taken: (p: string) => boolean, path: string): string => {
  if (!taken(path)) return path
  const { dir, stem, ext } = splitName(path)
  for (let n = 1; n < 1000; n++) {
    const name = `${stem}${n === 1 ? ' copy' : ` copy ${n}`}${ext}`
    const candidate = dir ? `${dir}/${name}` : name
    if (!taken(candidate)) return candidate
  }
  return path
}

/**
 * The `n`th name for a new file at `path`, the way New Note numbers `Untitled`:
 * `path` itself for 1, then `notes/meeting 2.pdf`, `notes/meeting 3.pdf`. The
 * caller asks for the next `n` while the file is there, so a new file never
 * replaces one. A `.local.` marker stays in the extension, as for a copy.
 */
export const numberedPath = (path: string, n: number): string => {
  if (n <= 1) return path
  const { dir, stem, ext } = splitName(path)
  const name = `${stem} ${n}${ext}`
  return dir ? `${dir}/${name}` : name
}
