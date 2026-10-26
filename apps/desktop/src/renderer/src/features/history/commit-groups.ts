/**
 * The history dialog's list, as GitHub's commits page has it: filtered by
 * who and by when, then grouped under the day each commit was made, in this
 * machine's time zone.
 */
import type { FileCommit } from './use-file-history'

export const PERIODS = ['all', 'week', 'month', 'year'] as const
export type Period = (typeof PERIODS)[number]

export const PERIOD_LABEL: Record<Period, string> = {
  all: 'All time',
  week: 'Last 7 days',
  month: 'Last 30 days',
  year: 'Last year',
}

const PERIOD_DAYS: Record<Exclude<Period, 'all'>, number> = {
  week: 7,
  month: 30,
  year: 365,
}

/** Everyone in the list, once each, in the order they last committed. */
export function commitAuthors(commits: readonly FileCommit[]): string[] {
  return [...new Set(commits.map((c) => c.author))]
}

export function filterCommits(
  commits: readonly FileCommit[],
  author: string | null,
  period: Period,
  now: number = Date.now(),
): FileCommit[] {
  const since = period === 'all' ? -Infinity : now - PERIOD_DAYS[period] * 86_400_000
  return commits.filter(
    (c) => (author === null || c.author === author) && Date.parse(c.date) >= since,
  )
}

export interface CommitDay {
  /** `YYYY-MM-DD` in local time: the group's key. */
  day: string
  /** "Aug 5, 2026". */
  label: string
  commits: FileCommit[]
}

function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const DAY_LABEL = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

/** Newest-first commits under their day, the days newest first too. */
export function groupByDay(commits: readonly FileCommit[]): CommitDay[] {
  const days: CommitDay[] = []
  for (const commit of commits) {
    const date = new Date(commit.date)
    const day = localDay(date)
    const last = days.at(-1)
    if (last?.day === day) last.commits.push(commit)
    else days.push({ day, label: DAY_LABEL.format(date), commits: [commit] })
  }
  return days
}
