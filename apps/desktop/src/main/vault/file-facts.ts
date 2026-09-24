/**
 * Facts about one file that are not in it: who made it and when, how often it
 * has changed, and how it is linked.
 *
 * The frontmatter block shows these beside the fields, read-only. None of them
 * is written into the file, because each already has an authority that a copy
 * could only drift from: git's history for the first three, the vault's
 * wiki-links for the last. `created` used to be a frontmatter date for exactly
 * that reason's opposite, and stopped being one.
 */
import { parseWikiLinks } from '@holi/shared'
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

/** How many distinct things `text` links to, not counting itself. A target
 *  linked five times is one outgoing link, the way a backlink is one file. */
export function linksOut(text: string, self: string): number {
  const targets = new Set(parseWikiLinks(text).map((l) => l.target))
  targets.delete(self)
  return targets.size
}
