/** Where a vault's last split widths for a member count are kept, on this
 *  machine (docs/features/tabs-panes.md, Persistence). */
function sharesStorageKey(remote: string | null, count: number): string {
  return `holi.panes.${remote ?? ''}.${count}`
}

export function readShares(remote: string | null, count: number): number[] | null {
  try {
    const raw = localStorage.getItem(sharesStorageKey(remote, count))
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    return Array.isArray(parsed) &&
      parsed.length === count &&
      parsed.every((n) => typeof n === 'number' && n > 0)
      ? (parsed as number[])
      : null
  } catch {
    return null
  }
}

export function writeShares(remote: string | null, shares: number[]): void {
  try {
    localStorage.setItem(sharesStorageKey(remote, shares.length), JSON.stringify(shares))
  } catch {
    // Storage off (a private window): the widths last the session only.
  }
}
