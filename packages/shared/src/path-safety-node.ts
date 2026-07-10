/**
 * The fs-canonicalizing half of path safety (Node-only — exported as
 * `@holi/shared/path-safety-node` so the browser-safe root export never
 * touches node:fs). Guards the file bridge and any agent-supplied path.
 */
import { realpath } from 'node:fs/promises'
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
