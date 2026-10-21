/**
 * The agent's work log: one machine-local markdown file per day under
 * `.holi/state/log/`, one line per thing done, so "what did you do this week?"
 * is a grep. Personal and never synced (the `.local.` marker): it is what ran
 * on this machine. `holi agent notify` writes a line to it as well as to the
 * inbox (docs/features/agent-inbox.md), and `holi agent log` writes one on its
 * own (docs/features/agent-memory.md). Holi keeps `WORK_LOG_KEEP_DAYS` of it.
 *
 * No Electron import: this loads under plain Node like the rest of the plugin.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DAY_MS, formatDate, localDate, parseDate } from '@holi/shared'

export const WORK_LOG_DIR = '.holi/state/log'

/** How many days of log Holi keeps, today included. A month answers "what did
 *  we do last week?" with room to spare; older days are deleted. */
export const WORK_LOG_KEEP_DAYS = 30

/** The day's log, by the machine's local date. */
export const workLogPath = (at: Date): string => `${WORK_LOG_DIR}/${localDate(at)}.local.md`

/** One line: the local time, then `text` on one line. */
export function workLogLine(at: Date, text: string): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `- ${pad(at.getHours())}:${pad(at.getMinutes())} ${text.replace(/\s*\n\s*/g, ' ').trim()}\n`
}

/** Append one line to the day's log in the vault at `root`. */
export async function appendWorkLog(root: string, at: Date, text: string): Promise<void> {
  const path = join(root, workLogPath(at))
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, workLogLine(at, text), 'utf8')
}

/** The day files in `WORK_LOG_DIR` (by name) older than the last `keep` days
 *  up to `today` (`YYYY-MM-DD`). Anything that is not a day file is left. */
export function staleWorkLogs(names: string[], today: string, keep: number): string[] {
  const first = parseDate(today)
  if (first === null) return []
  const oldest = formatDate(first - (keep - 1) * DAY_MS)
  return names.filter((name) => {
    const day = /^(\d{4}-\d{2}-\d{2})\.local\.md$/.exec(name)?.[1]
    return day !== undefined && parseDate(day) !== null && day < oldest
  })
}
