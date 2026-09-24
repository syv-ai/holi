/**
 * The read-only facts the frontmatter block shows beside its fields: the file's
 * git history and how it is linked (`main/vault/file-facts.ts`).
 *
 * Asked for when the block mounts, which is when it opens: the backlink half
 * reads every note in the vault, and a collapsed block never needs it.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useState } from 'react'
import { trpc } from '../lib/trpc'
import { activeRemoteAtom } from './vaults'

export interface CommitFact {
  date: string
  author: string
}

export interface FileFacts {
  /** Null for a file with no commits yet. */
  history: { last: CommitFact; first: CommitFact; revisions: number } | null
  links: { in: number; out: number } | null
}

/** Null until the first answer arrives. Either half failing leaves that half
 *  null rather than hiding the other. */
export function useFileFacts(path: string): FileFacts | null {
  const remote = useAtomValue(activeRemoteAtom)
  const [facts, setFacts] = useState<FileFacts | null>(null)
  useEffect(() => {
    let live = true
    setFacts(null)
    void Promise.all([
      trpc.notes.fileHistory.query({ path }).catch(() => null),
      remote === null ? null : trpc.notes.links.query({ remote, path }).catch(() => null),
    ]).then(([history, links]) => {
      if (live) setFacts({ history, links })
    })
    return () => {
      live = false
    }
  }, [path, remote])
  return facts
}
