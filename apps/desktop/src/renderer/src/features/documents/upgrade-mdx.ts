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
  if (claims.some((claim) => claim.match(path))) return null
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
    claims.some((claim) => claim.match(to))
  )
    return null
  return { from: path, to }
}
