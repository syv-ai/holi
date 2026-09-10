/**
 * The " copy" / " copy 2" naming rule (VS Code's Duplicate).
 *
 * Shared because it is applied in two places that must agree: duplicating
 * inside the vault, and exporting to a folder on disk that already holds a file
 * of that name. Collision is asked of `taken` rather than of a filesystem, so
 * the same rule serves an in-memory path list and a real directory.
 *
 * Paths are '/'-separated: vault-relative in the renderer, POSIX absolute in
 * main. Holi is macOS-only, and `vaultRelPath` already refuses backslashes.
 */
export const freeCopyPath = (taken: (p: string) => boolean, path: string): string => {
  if (!taken(path)) return path
  const slash = path.lastIndexOf('/')
  const base = path.slice(slash + 1)
  const dir = slash === -1 ? '' : path.slice(0, slash)
  /**
   * **A `.local.` marker counts as part of the extension** (D65).
   *
   * Splitting on the last dot alone turned `notes.local.md` into
   * `notes.local copy.md`, where `local` is followed by a space rather than a
   * dot — so `isLocalOnlyPath` stopped matching it, `*.local.*` stopped
   * ignoring it, and duplicating a personal file **published it**. Observed in
   * a real vault: a duplicated `memory/x.local.md` was committed and listed in
   * the shared memory index.
   *
   * Fixed here rather than by widening the marker, because the marker being one
   * exact spelling is the whole of D65 — and because a "local" file git still
   * commits is worse than no marker at all. The copy is `notes copy.local.md`.
   */
  const localExt = /\.local\.[^.]+$/.exec(base)
  const dot = localExt !== null ? localExt.index : base.lastIndexOf('.')
  // `dot > 0`, not `dot >= 0`: a leading dot is a dotfile's name, not an
  // extension, so `.gitignore` must not become ' copy.gitignore'.
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let n = 1; n < 1000; n++) {
    const name = `${stem}${n === 1 ? ' copy' : ` copy ${n}`}${ext}`
    const candidate = dir ? `${dir}/${name}` : name
    if (!taken(candidate)) return candidate
  }
  return path
}
