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
  const dot = base.lastIndexOf('.')
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
