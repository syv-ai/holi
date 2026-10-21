/**
 * A vault's repo at a glance (docs/features/vaults-sync.md, Repo size).
 *
 * `RepoUsage` is how full it is on GitHub: muted until it matters, then ramping
 * amber to red (`fillColour`), and blank until GitHub has answered, since a
 * guess would be a number someone acts on. `RepoMeter` is that plus a GitHub
 * link, right-aligned at the end of a vault picker row.
 */
import { SiGithub } from '@icons-pack/react-simple-icons'
import { fillColour, formatRepoSize, REPO_SIZE_LIMIT_KB, repoUsagePercent } from '@holi/shared'
import { IconButton, Tooltip } from '@/primitives'
import { cn } from '@/lib/cn'

export function RepoUsage({
  sizeKb,
  className,
}: {
  /** GitHub's size in KiB, or null before it is known. */
  sizeKb: number | null
  /** Layout only. */
  className?: string
}): React.JSX.Element | null {
  if (sizeKb === null) return null
  const percent = repoUsagePercent(sizeKb)
  return (
    <Tooltip
      content={`${formatRepoSize(sizeKb)} of ${formatRepoSize(REPO_SIZE_LIMIT_KB)} on GitHub`}
    >
      <span
        data-repo-usage={percent}
        className={cn('shrink-0 text-xs text-muted-foreground tabular-nums', className)}
        style={{ color: fillColour(percent) ?? undefined }}
      >
        {percent}%
      </span>
    </Tooltip>
  )
}

export function RepoMeter({
  sizeKb,
  onOpen,
}: {
  sizeKb: number | null
  onOpen: () => void
}): React.JSX.Element {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 pl-2">
      <RepoUsage sizeKb={sizeKb} />
      <IconButton icon={SiGithub} label="Open on GitHub" data-repo-link="" onClick={onOpen} />
    </span>
  )
}
