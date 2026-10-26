/**
 * `+40 −3`: how much a commit changed. A composite because both history lists
 * show it (the vault's sums a whole commit, a note's just that file).
 *
 * Nothing is drawn when both are zero: a merge commit has no diff of its own
 * for `--numstat`, and `+0 −0` would read as a commit that did nothing.
 */
export function Churn({
  added,
  removed,
}: {
  added: number
  removed: number
}): React.JSX.Element | null {
  if (added === 0 && removed === 0) return null
  return (
    <span className="ml-1 whitespace-nowrap tabular-nums">
      {added > 0 && <span className="text-diff-added-foreground">+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span className="text-diff-removed-foreground">−{removed}</span>}
    </span>
  )
}
