/**
 * Facts about one file that are not in it: who made it and when, and how often
 * it has changed.
 *
 * The frontmatter header and the history drawer show these, read-only. None of
 * them is written into the file, because git's history already holds them and a
 * copy could only drift from it.
 */
import type { Commit } from '../git'

export interface CommitFact {
  /** ISO 8601, git author date. */
  date: string
  /** Git author name (`%an`). */
  author: string
}

export interface FileHistory {
  /** The newest commit touching the file: "last updated". */
  last: CommitFact
  /** The oldest, following renames: the file's creation. */
  first: CommitFact
  /** How many commits touched it, the first included. */
  revisions: number
}

/** A file's history from its `git log --follow`, newest first as git prints it.
 *  Null for a file with no commits yet, which has no creation to report. */
export function fileHistory(commits: readonly Commit[]): FileHistory | null {
  const last = commits[0]
  const first = commits.at(-1)
  if (last === undefined || first === undefined) return null
  return {
    last: { date: last.date, author: last.author },
    first: { date: first.date, author: first.author },
    revisions: commits.length,
  }
}
