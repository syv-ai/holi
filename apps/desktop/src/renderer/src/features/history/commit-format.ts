/** How a commit's author and age read in the history views. */

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length >= 2 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '?').slice(0, 2)
  return letters.toUpperCase()
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** "just now", "3 hours ago", "2 months ago": finer than the vault's
 *  day-grained `relativeTime`, since a commit an hour old is news. */
export function commitAge(iso: string, now: number = Date.now()): string {
  const seconds = (Date.parse(iso) - now) / 1000
  if (Number.isNaN(seconds)) return ''
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 86_400],
    ['month', 30 * 86_400],
    ['week', 7 * 86_400],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ]
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) {
      return relative.format(Math.round(seconds / size), unit)
    }
  }
  return 'just now'
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}
