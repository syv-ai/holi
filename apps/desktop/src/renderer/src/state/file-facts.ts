/**
 * The read-only facts the frontmatter block shows beside its fields: the file's
 * git history and how it is linked (`main/vault/file-facts.ts`).
 *
 * Asked for when the block mounts, which is when it opens: the backlink half
 * reads every note in the vault, and a collapsed block never needs it. Asked
 * again when a commit takes the file, so a note opened before its first
 * autosave commit gains its "created" part when that lands.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useState } from 'react'
import { trpc } from '../lib/trpc'
import { activeRemoteAtom, historyEpoch, historyEpochsAtom } from './vaults'

export interface CommitFact {
  date: string
  author: string
}

export interface FileFacts {
  /** Null for a file with no commits yet. */
  history: { last: CommitFact; first: CommitFact; revisions: number } | null
  links: { in: number; out: number } | null
}

/** Null until the first answer for this path arrives; a refetch keeps the
 *  last answer showing. Either half failing leaves that half null rather than
 *  hiding the other. */
export function useFileFacts(path: string): FileFacts | null {
  const remote = useAtomValue(activeRemoteAtom)
  const epoch = historyEpoch(useAtomValue(historyEpochsAtom), path)
  const [answer, setAnswer] = useState<{ path: string; facts: FileFacts } | null>(null)
  useEffect(() => {
    let live = true
    void Promise.all([
      trpc.notes.fileHistory.query({ path }).catch(() => null),
      remote === null ? null : trpc.notes.links.query({ remote, path }).catch(() => null),
    ]).then(([history, links]) => {
      if (live) setAnswer({ path, facts: { history, links } })
    })
    return () => {
      live = false
    }
  }, [path, remote, epoch])
  return answer?.path === path ? answer.facts : null
}
