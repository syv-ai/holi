/**
 * An OS path (a drop, a terminal's output) as the vault path it names: one
 * rule for the places that read one, in the browser and in main. Pure, with
 * the platform an argument, so both spellings are testable on any machine.
 *
 * On `win32` either separator is read, a drive letter and every name fold
 * their case, and Git Bash's `/c/Users/…` is `C:/Users/…`. On `posix` a path
 * is read exactly: a backslash is a character in a name and `/c/` is a folder.
 */

export type PathPlatform = 'win32' | 'posix'

/** Git Bash's `/c/Users/…` as `C:/Users/…`. */
const msysDrive = (path: string): string =>
  path.replace(/^\/([A-Za-z])(?=\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:`)

const slashed = (path: string, platform: PathPlatform): string =>
  platform === 'win32' ? msysDrive(path).replaceAll('\\', '/') : path

const folded = (name: string, platform: PathPlatform): string =>
  platform === 'win32' ? name.toLowerCase() : name

/**
 * What follows the vault's root in `osPath`, written with `/`, in `osPath`'s
 * own spelling; null when `osPath` is the root itself or lies elsewhere. A
 * doubled separator stays in the answer (`/a.md`) for the caller to refuse.
 */
export function pathBelowRoot(root: string, osPath: string, platform: PathPlatform): string | null {
  const top = `${slashed(root, platform).replace(/\/+$/, '')}/`
  const here = slashed(osPath, platform)
  if (!folded(here, platform).startsWith(folded(top, platform))) return null
  return here.length > top.length ? here.slice(top.length) : null
}

/** The vault's paths (files and folders), looked up by the OS's own reading of
 *  a name: folded on Windows, exact elsewhere. */
export type VaultPathIndex = ReadonlyMap<string, string>

export function vaultPathIndex(paths: Iterable<string>, platform: PathPlatform): VaultPathIndex {
  const index = new Map<string, string>()
  for (const path of paths) {
    const key = folded(path, platform)
    if (!index.has(key)) index.set(key, path)
  }
  return index
}

/**
 * The vault path `osPath` names, in the spelling the vault's snapshot has:
 * `c:\users\ada\holi\r\notes\plan.MD` is `Notes/Plan.md` when that is the
 * file. Null when it is outside the vault, is the root, or names nothing the
 * snapshot holds.
 */
export function resolveVaultPath(
  root: string,
  osPath: string,
  index: VaultPathIndex,
  platform: PathPlatform,
): string | null {
  const rel = pathBelowRoot(root, osPath, platform)
  if (rel === null || rel.startsWith('/')) return null
  return index.get(folded(rel, platform)) ?? null
}
