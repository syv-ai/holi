/**
 * `+40 −3` — how much a commit changed, at a glance.
 *
 * In `composites/` rather than in either history feature because both lists
 * show it and a feature may not import another one. The two mean subtly
 * different things and that is fine: the vault's history sums a whole commit,
 * a note's own history sums just that file, because `log` was given a path.
 *
 * **Nothing is drawn when both are zero**, which is not a tidiness rule. A
 * merge commit has no diff of its own for `--numstat` to report, so it would
 * otherwise read as `+0 −0` and look like a commit that did nothing rather than
 * one whose changes came from somewhere else.
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
