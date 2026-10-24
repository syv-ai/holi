import { describe, expect, it } from "vitest"

import {
  commitAuthors,
  filterCommits,
  groupByDay,
} from "../commit-groups"
import { commitAge } from "../use-file-history"
import type { FileCommit } from "../use-file-history"

const commit = (sha: string, date: string, author = "Ana"): FileCommit => ({
  sha,
  subject: `Commit ${sha}`,
  date,
  author,
  added: 1,
  removed: 0,
})

const NOW = Date.parse("2026-10-24T12:00:00")

describe("the history dialog's list", () => {
  const commits = [
    commit("c", "2026-10-24T09:00:00", "Ana"),
    commit("b", "2026-10-24T08:00:00", "Bo"),
    commit("a", "2026-08-05T10:00:00", "Ana"),
  ]

  it("groups commits under their day, newest first", () => {
    const days = groupByDay(commits)
    expect(days.map((d) => d.label)).toEqual(["Oct 24, 2026", "Aug 5, 2026"])
    expect(days[0]!.commits.map((c) => c.sha)).toEqual(["c", "b"])
  })

  it("filters by who and by when", () => {
    expect(filterCommits(commits, "Ana", "all", NOW).map((c) => c.sha)).toEqual(
      ["c", "a"]
    )
    expect(filterCommits(commits, null, "week", NOW).map((c) => c.sha)).toEqual(
      ["c", "b"]
    )
    expect(filterCommits(commits, "Bo", "all", NOW)).toHaveLength(1)
  })

  it("lists each author once, in the order they last committed", () => {
    expect(commitAuthors(commits)).toEqual(["Ana", "Bo"])
  })
})

describe("a commit's age", () => {
  it("reads like the header's, down to the hour", () => {
    expect(commitAge("2026-10-24T11:59:40", NOW)).toBe("just now")
    expect(commitAge("2026-10-24T09:00:00", NOW)).toBe("3 hours ago")
    expect(commitAge("2026-08-05T10:00:00", NOW)).toBe("3 months ago")
  })
})
