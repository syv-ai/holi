/**
 * The read-only facts the frontmatter block shows beside its fields: the file's
 * git history and how it is linked (`main/vault/file-facts.ts`).
 *
 * The links are asked for when the block mounts, which is when it opens: they
 * read every note in the vault, and a collapsed block never needs them. Both
 * halves follow the file's history epoch, so a note opened before its first
 * autosave commit gains its "created" part when that lands.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useState } from 'react'
import { trpc } from '../lib/trpc'
import { fileHistoryAtom, type FileHistory } from './file-history'
import { activeRemoteAtom, historyEpoch, historyEpochsAtom } from './vaults'

export interface FileFacts {
  /** Null for a file with no commits yet. */
  history: FileHistory | null
  links: { in: number; out: number } | null
}

/** Null until both halves have answered for this path; a refetch keeps the
 *  last answer showing. Either half failing leaves that half null rather than
 *  hiding the other. The history half is the shared `fileHistoryAtom`; the
 *  links half is this hook's own fetch. */
export function useFileFacts(path: string): FileFacts | null {
  const remote = useAtomValue(activeRemoteAtom)
  const history = useAtomValue(fileHistoryAtom(path))
  const epoch = historyEpoch(useAtomValue(historyEpochsAtom), path)
  const [links, setLinks] = useState<{ path: string; links: FileFacts['links'] } | null>(null)
  useEffect(() => {
    let live = true
    void (remote === null ? Promise.resolve(null) : trpc.notes.links.query({ remote, path }))
      .catch(() => null)
      .then((answer) => {
        if (live) setLinks({ path, links: answer })
      })
    return () => {
      live = false
    }
  }, [path, remote, epoch])
  if (history === undefined || links?.path !== path) return null
  return { history, links: links.links }
}
