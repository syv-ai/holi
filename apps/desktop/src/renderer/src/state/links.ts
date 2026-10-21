/**
 * The links drawer and the graph: both directions of the focused note's
 * wiki-links (`docs/features/wiki-links.md`) and the vault's whole link graph
 * (`docs/features/graph.md`). There is no link index to keep current, only a
 * scan per ask, so both ask main again when `linkFingerprintAtom` changes.
 */
import { atom } from 'jotai'
import { trpc } from '../lib/trpc'
import { snapshotAtom } from './vaults'

export type NoteLinks = Awaited<ReturnType<typeof trpc.notes.links.query>>

export const linksOpenAtom = atom(false)

/**
 * What the link scans read, as one string: every markdown note with its mtime,
 * every claimed file (a task is a note too) as parsed, and the other files'
 * paths, since a link may point at one. The snapshot is pushed on every
 * watcher event and every heal tick whether or not anything changed; a string
 * compares equal across those, so a scan follows only a real change.
 */
export const linkFingerprintAtom = atom((get) => {
  const { docs, claimed, files } = get(snapshotAtom)
  let out = ''
  for (const d of docs) out += `${d.path}\t${d.updatedAt}\n`
  // Claimed items carry no mtime: their parsed content stands in for one.
  for (const id of Object.keys(claimed).sort()) out += `${id}\t${JSON.stringify(claimed[id])}\n`
  for (const f of files) out += `${f.path}\n`
  return out
})
