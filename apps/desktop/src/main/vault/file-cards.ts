/**
 * What the finder shows about each file in a folder, beyond its name: how big
 * it is, who last changed it and when, and, for a note, what it is about
 * (`summarizeNote`: its description, tags, length and first lines).
 *
 * **Git is the record of "who and when"**, as for the frontmatter header
 * (`file-facts.ts`): the last commit that touched the file, never the mtime,
 * which a clone or a pull resets. A file with no commit yet (just made) has
 * none, and the finder falls back to its mtime.
 *
 * One git process per file, a few at a time: a folder is tens of files, and
 * `git log -1` per path is the cheapest exact answer.
 */
import { readFile, stat } from 'node:fs/promises'
import { summarizeNote, type NoteSummary, type VaultRelPath } from '@holi/shared'
import type { CommitFact } from './file-facts'
import { absPathFor } from './vault-files'

export interface FileCard {
  path: string
  /** Bytes on disk; 0 when the file has gone. */
  size: number
  /** The last commit that touched it, or null before its first. */
  last: CommitFact | null
  /** A note's summary; absent for any other kind of file. */
  note?: NoteSummary
}

/** At most this many files per call: a folder is a screen, not the vault. */
const FILE_CARDS_LIMIT = 200
/** Git processes at once. */
const PARALLEL = 6

export async function fileCards(
  root: string,
  paths: readonly VaultRelPath[],
  lastCommit: (path: VaultRelPath) => Promise<CommitFact | null>,
): Promise<FileCard[]> {
  const wanted = paths.slice(0, FILE_CARDS_LIMIT)
  const out: FileCard[] = new Array(wanted.length)
  let next = 0
  const worker = async () => {
    while (next < wanted.length) {
      const i = next++
      const path = wanted[i]!
      out[i] = await cardFor(root, path, lastCommit)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, wanted.length) }, worker))
  return out
}

async function cardFor(
  root: string,
  path: VaultRelPath,
  lastCommit: (path: VaultRelPath) => Promise<CommitFact | null>,
): Promise<FileCard> {
  const abs = absPathFor(root, path)
  const [info, last] = await Promise.all([
    stat(abs).catch(() => null),
    lastCommit(path).catch(() => null),
  ])
  const card: FileCard = { path, size: info?.size ?? 0, last }
  if (/\.md$/i.test(path) && info !== null) {
    const text = await readFile(abs, 'utf8').catch(() => null)
    if (text !== null) card.note = summarizeNote(text)
  }
  return card
}
