import { useAtomValue } from "jotai"
import { useCallback, useEffect, useState } from "react"

import { trpc } from "@/lib/trpc"
import {
  activeRemoteAtom,
  historyEpoch,
  historyEpochsAtom,
} from "@/state/vaults"

/** One of a file's commits, as `history.list` gives it. */
export interface FileCommit {
  sha: string
  subject: string
  /** ISO 8601, author date. */
  date: string
  author: string
  /** Lines this commit added to and removed from the file. */
  added: number
  removed: number
}

/** Someone who has committed to the file, matched to GitHub where git's
 *  author is a GitHub account. */
export interface FileAuthor {
  login: string | null
  name: string
  avatarUrl: string | null
}

export type FileHistory =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; commits: FileCommit[] }

/**
 * A file's commits, newest first, following renames; read again whenever
 * the file's history moves (an autosave commit, a pull), so the header's
 * latest commit stays the latest.
 */
export function useFileHistory(path: string): {
  history: FileHistory
  retry: () => void
} {
  const epoch = historyEpoch(useAtomValue(historyEpochsAtom), path)
  const [history, setHistory] = useState<FileHistory>({ kind: "loading" })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    trpc.history.list
      .query({ path })
      .then((commits) => live && setHistory({ kind: "ready", commits }))
      .catch(
        (err: unknown) =>
          live &&
          setHistory({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          })
      )
    return () => {
      live = false
    }
  }, [path, epoch, attempt])

  const retry = useCallback(() => {
    setHistory({ kind: "loading" })
    setAttempt((n) => n + 1)
  }, [])
  return { history, retry }
}

/** Who has written the file, with GitHub faces where there are some
 *  (`github.fileContributors`; local names when GitHub cannot answer). */
export function useFileAuthors(path: string): FileAuthor[] {
  const remote = useAtomValue(activeRemoteAtom)
  const epoch = historyEpoch(useAtomValue(historyEpochsAtom), path)
  const [authors, setAuthors] = useState<FileAuthor[]>([])

  useEffect(() => {
    if (remote === null) return
    let live = true
    trpc.github.fileContributors
      .query({ remote, path })
      .then((found) => live && setAuthors(found))
      .catch(() => live && setAuthors([]))
    return () => {
      live = false
    }
  }, [remote, path, epoch])

  return authors
}

/** A commit's author among the file's authors, by git name or login. */
export function authorFor(
  authors: readonly FileAuthor[],
  name: string
): FileAuthor {
  const key = name.toLowerCase()
  return (
    authors.find(
      (a) => a.name.toLowerCase() === key || a.login?.toLowerCase() === key
    ) ?? { login: null, name, avatarUrl: null }
  )
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters =
    words.length >= 2
      ? words[0]![0]! + words[1]![0]!
      : (words[0] ?? "?").slice(0, 2)
  return letters.toUpperCase()
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

/** "just now", "3 hours ago", "2 months ago": finer than the vault's
 *  day-grained `relativeTime`, since a commit an hour old is news. */
export function commitAge(iso: string, now: number = Date.now()): string {
  const seconds = (Date.parse(iso) - now) / 1000
  if (Number.isNaN(seconds)) return ""
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 86_400],
    ["month", 30 * 86_400],
    ["week", 7 * 86_400],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ]
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) {
      return relative.format(Math.round(seconds / size), unit)
    }
  }
  return "just now"
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}
