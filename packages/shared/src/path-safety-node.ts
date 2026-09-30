/**
 * The fs-canonicalizing half of path safety (Node-only, exported as
 * `@holi/shared/path-safety-node` so the browser-safe root export never
 * touches node:fs). Guards the file bridge and any agent-supplied path.
 */
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { PathSafetyError, vaultRelPath } from './path-safety'

/**
 * Resolve `rel` against `vaultRoot` and prove the result stays inside the
 * vault: lexical validation (via vaultRelPath), then canonicalize through the
 * closest existing ancestor (following symlinks), then re-assert containment.
 * The leaf need not exist (create case). Throws PathSafetyError on rejection.
 */
export async function resolveRelative(vaultRoot: string, rel: string): Promise<string> {
  const validated = vaultRelPath(rel)
  const root = await realpath(vaultRoot)
  const abs = join(root, validated)

  // Walk up to the closest existing ancestor, canonicalize it (this is what
  // resolves a planted symlink to wherever it actually points), and keep the
  // not-yet-existing suffix to reattach.
  let anchor = abs
  const suffix: string[] = []
  let canonicalAnchor: string
  for (;;) {
    try {
      canonicalAnchor = await realpath(anchor)
      break
    } catch {
      const parent = dirname(anchor)
      if (parent === anchor) {
        throw new PathSafetyError(`path has no existing ancestor: ${rel}`)
      }
      suffix.push(basename(anchor))
      anchor = parent
    }
  }

  // Containment is asserted on the CANONICAL anchor, component-wise (so
  // /vaults-evil never matches /vaults). The suffix is already lexically
  // clean (no '..'), so anchor containment covers the whole path.
  if (canonicalAnchor !== root && !canonicalAnchor.startsWith(root + sep)) {
    throw new PathSafetyError(`path escapes vault: ${rel}`)
  }
  return join(canonicalAnchor, ...suffix.reverse())
}

/**
 * `rel` under `root` only when that IS the file on disk, or null.
 *
 * Stricter than `resolveRelative`, which follows a link that stays inside the
 * vault: here no existing component may be a symlink at all, and every existing
 * name must have the case it has on disk. The canonical path of the closest
 * existing ancestor has to equal the lexical one, which says both at once:
 * `realpath` resolves links and, on macOS, returns the case on disk, so a
 * `Data/` that opens `data/` is refused as surely as a link to `memory/`.
 *
 * For paths whose checks are lexical (an app's own bundle, its store, the
 * agent surface): a link or a case alias would let the name that was checked
 * differ from the file that is opened. The leaf need not exist (a write).
 */
export async function exactPath(root: string, rel: string): Promise<string | null> {
  let validated
  try {
    validated = vaultRelPath(rel)
  } catch {
    return null
  }
  const canonicalRoot = await realpath(root).catch(() => null)
  if (canonicalRoot === null) return null
  const abs = join(canonicalRoot, validated)
  for (let anchor = abs; ;) {
    const canonical = await realpath(anchor).catch(() => null)
    if (canonical !== null) return canonical === anchor ? abs : null
    // Only a name that is truly absent walks up. A dangling link or a loop
    // fails `realpath` too, but it exists, and a write would go through it.
    if (
      await lstat(anchor).then(
        () => true,
        () => false,
      )
    )
      return null
    const parent = dirname(anchor)
    if (parent === anchor) return null
    anchor = parent
  }
}
