/** Wall-clock ⇄ UTC conversion at the scheduler edge (stub #4: one
 * server-wide zone). The shared reminder math never sees timezones. */

function zoneOffsetMs(at: Date, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  )
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return asUtc - at.getTime()
}

/** `YYYY-MM-DDTHH:MM[:SS]` wall-clock in `zone` → UTC Date (two-pass for DST edges). */
export function localToUtc(local: string, zone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local)
  if (!m) throw new Error(`invalid local datetime: ${local}`)
  const wall = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  )
  let utc = wall
  for (let i = 0; i < 2; i++) utc = wall - zoneOffsetMs(new Date(utc), zone)
  return new Date(utc)
}

/** UTC Date → `YYYY-MM-DDTHH:MM` wall-clock in `zone`. */
export function utcToLocal(at: Date, zone: string): string {
  const shifted = new Date(at.getTime() + zoneOffsetMs(at, zone))
  return shifted.toISOString().slice(0, 16)
}

/** Today's `YYYY-MM-DD` in `zone` — feeds nextDueCatchup. */
export function todayLocal(zone: string, now = new Date()): string {
  return utcToLocal(now, zone).slice(0, 10)
}
