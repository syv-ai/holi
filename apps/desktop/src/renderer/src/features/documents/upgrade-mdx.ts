import {
  isAgentSurfacePath,
  isAppWritablePath,
  isDailyNoteFilename,
  isLocalOnlyPath,
  isVaultConfigPath,
  SCRATCHPAD_PATH,
  TASKS_CLAIM,
  type VaultSnapshot,
} from '@holi/shared'
import type { PathClaim } from '@/state/plugin-types'

/** Return the exact source pair when an ordinary note can safely become MDX. */
export function mdxUpgradeMove(
  path: string,
  snapshot: VaultSnapshot,
  claims: readonly PathClaim[],
): { from: string; to: string } | null {
  if (!path.toLowerCase().endsWith('.md')) return null
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (
    path === SCRATCHPAD_PATH ||
    isLocalOnlyPath(path) ||
    /(?:^|\/)task\.[^/]+\.md$/i.test(path) ||
    isDailyNoteFilename(name)
  )
    return null
  if (!isAppWritablePath(path) || isAgentSurfacePath(path) || isVaultConfigPath(path)) return null
  if (claims.some((claim) => ownsPath(claim, path))) return null
  if (snapshot.claimed[TASKS_CLAIM]?.items.some((item) => item.path === path)) return null
  if (snapshot.claimed[TASKS_CLAIM]?.broken.some((item) => item.path === path)) return null
  const source = snapshot.docs.find((doc) => doc.path === path)
  if (!source || source.kind === 'daily') return null

  const to = `${path.slice(0, -3)}.mdx`
  const destination = to.toLowerCase()
  if (
    snapshot.docs.some((entry) => entry.path.toLowerCase() === destination) ||
    snapshot.files.some((entry) => entry.path.toLowerCase() === destination) ||
    snapshot.dirs.some((dir) => dir.toLowerCase() === destination) ||
    claims.some((claim) => ownsPath(claim, to))
  )
    return null
  return { from: path, to }
}

/** Row-menu items add actions to a path; they do not make it plugin-owned. */
function ownsPath(claim: PathClaim, path: string): boolean {
  return (
    claim.match(path) &&
    (claim.view !== undefined ||
      claim.retainView === true ||
      claim.folder !== undefined ||
      claim.decorate !== undefined ||
      claim.hover !== undefined ||
      claim.banner !== undefined ||
      claim.normalize !== undefined ||
      claim.create !== undefined)
  )
}
