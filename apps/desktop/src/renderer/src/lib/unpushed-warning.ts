/**
 * The sentence the sign-out dialog shows when "also delete local clones" would
 * throw away commits that were never pushed. Advisory: the summary is
 * best-effort (an unreadable clone is absent), so the copy warns rather than
 * promises. `null` means no warning.
 */
export interface UnpushedEntry {
  remote: string
  ahead: number
}

export function unpushedWarning(summary: UnpushedEntry[]): string | null {
  if (summary.length === 0) return null
  if (summary.length === 1) {
    const { remote, ahead } = summary[0]!
    return `${remote} has ${ahead} unpushed commit${ahead === 1 ? '' : 's'}`
  }
  const total = summary.reduce((sum, e) => sum + e.ahead, 0)
  return `${summary.length} vaults have unpushed commits (${total} total)`
}
