/**
 * Ordering semver versions: `1.2.3`, with an optional prerelease
 * (`1.2.3-dev.4`), which sorts below its release. Build metadata is not part
 * of a Holi version, so it is not handled.
 */

const parts = (version: string): { core: number[]; pre: string[] } => {
  const dash = version.indexOf('-')
  const core = (dash === -1 ? version : version.slice(0, dash)).split('.').map(Number)
  const pre = dash === -1 ? [] : version.slice(dash + 1).split('.')
  return { core, pre }
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0)
    if (d !== 0) return d
  }
  // A release outranks any of its prereleases.
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x) ? Number(x) : null
    const ny = /^\d+$/.test(y) ? Number(y) : null
    if (nx !== null && ny !== null) return nx - ny
    // Numeric identifiers sort below alphanumeric ones.
    if (nx !== null) return -1
    if (ny !== null) return 1
    return x < y ? -1 : 1
  }
  return 0
}
