/**
 * One file's git history (`notes.fileHistory`): its last and first commit and
 * how many commits touched it. Fetched once per path and shared by everything
 * that shows it: the frontmatter header (last updated, `v.N`) and the history
 * drawer's revision count.
 *
 * Asked again whenever the file's history epoch moves (a commit took it, or a
 * pull merged), and never otherwise. A refetch holds the last answer, so
 * nothing blanks while it is in flight.
 */
import { atom, type Atom } from 'jotai'
import { unwrap } from 'jotai/utils'
import { trpc } from '../lib/trpc'
import { activeRemoteAtom, historyEpoch, historyEpochsAtom } from './vaults'

export interface CommitFact {
  /** ISO 8601 (git author date). */
  date: string
  /** Author name (git `%an`). */
  author: string
}

export interface FileHistory {
  last: CommitFact
  first: CommitFact
  /** Commits touching the file, the first included. */
  revisions: number
}

/** `undefined` until main first answers; null for a file with no commits yet,
 *  or when the fetch failed. */
export type FileHistoryAnswer = FileHistory | null | undefined

const byPath = new Map<string, Atom<FileHistoryAnswer>>()

/** The history of `path` in the active vault. The same atom for the same path,
 *  so every reader shares one fetch. */
export function fileHistoryAtom(path: string): Atom<FileHistoryAnswer> {
  let a = byPath.get(path)
  if (a === undefined) {
    a = build(path)
    byPath.set(path, a)
  }
  return a
}

function build(path: string): Atom<FileHistoryAnswer> {
  // Its own atom so a commit to another path, which changes `historyEpochsAtom`
  // but not this number, does not refetch.
  const epochAtom = atom((get) => historyEpoch(get(historyEpochsAtom), path))
  const fetched = atom(async (get) => {
    get(epochAtom)
    const remote = get(activeRemoteAtom)
    try {
      return { remote, history: await trpc.notes.fileHistory.query({ path }) }
    } catch {
      // Answered either way, or the header would wait for it forever.
      return { remote, history: null }
    }
  })
  const held = unwrap(fetched, (prev) => prev)
  // Main answers for the active vault, and a path can exist in two; the last
  // vault's answer must not stand in while the new one's is on its way.
  return atom((get) => {
    const answer = get(held)
    return answer?.remote === get(activeRemoteAtom) ? answer.history : undefined
  })
}
