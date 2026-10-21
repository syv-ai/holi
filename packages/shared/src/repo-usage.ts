/**
 * How full a vault's GitHub repo is (docs/features/vaults-sync.md, Repo size).
 *
 * GitHub enforces no total repository size (only 100 MiB per file and 2 GiB
 * per push), so "allowed" is the ceiling its Repository limits page
 * recommends: a `.git` of at most 10 GB on disk. The size is GitHub's `size` field, in KiB, which
 * it recomputes on its own schedule rather than on every push.
 */

/** GitHub's recommended maximum repository size, in KiB. */
export const REPO_SIZE_LIMIT_KB = 10 * 1024 * 1024

/** The share of the limit a repo of `sizeKb` uses, as a whole percent. */
export function repoUsagePercent(sizeKb: number): number {
  return Math.round((Math.max(sizeKb, 0) / REPO_SIZE_LIMIT_KB) * 100)
}

/** A KiB count in the largest unit that keeps it above one: "312 KB", "1.4 GB". */
export function formatRepoSize(sizeKb: number): string {
  const units = ['KB', 'MB', 'GB']
  let value = Math.max(sizeKb, 0)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
