/**
 * When something last moved, as a person says it: "Today", "3 days ago",
 * "last month". Day-grained on purpose: the finder and the join list want to
 * tell a live file from an abandoned one, not to timestamp it.
 */
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function relativeTime(iso: string, now: number = Date.now()): string {
  const days = Math.round((Date.parse(iso) - now) / 86_400_000)
  if (Number.isNaN(days)) return ''
  if (days > -1) return 'Today'
  if (days > -30) return relative.format(days, 'day')
  if (days > -365) return relative.format(Math.round(days / 30), 'month')
  return relative.format(Math.round(days / 365), 'year')
}
