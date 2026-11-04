/**
 * How long ago, in the short form a row shows: "now", "10m", "3d", then a
 * date. `precise` keeps the minutes under a day ("5h 43m") where the plain form
 * says "5h". After MonoCode's `formatRelative`.
 */
export function relativeAge(at: number, now: number, opts: { precise?: boolean } = {}): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return opts.precise === true && rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
  }
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(at))
}
