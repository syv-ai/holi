/**
 * What Holi seeded, so an update can tell what the vault changed.
 *
 * Holi's skills and hooks are the vault's files from the moment they are
 * written. `holi skills update` brings a newer shipped version to them, and to
 * do that without losing the vault's own edits it needs the **base**: the text
 * Holi seeded there. With it, an untouched file is replaced, an edited one is
 * 3-way merged, and only a real conflict needs an agent.
 *
 * **The text, not only a hash.** A hash answers "was this touched?", which is
 * enough to replace an untouched file but not to merge an edited one. Records
 * written before the text was kept hold only the hash, and still answer the
 * first question.
 *
 * **Machine-local, and the `.local.` in the name is the whole enforcement**.
 * A committed record would travel to a teammate and claim a base Holi
 * never wrote on their machine. A machine without a record merges nothing and
 * hands every diverged file to the agent, which loses nothing.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vaultRelPath } from '@holi/shared'
import { writeAtomic } from '../vault/vault-files'

export const SEED_STATE_FILE = '.holi/state/seed-state.local.json'

/** What Holi wrote at one path: its hash, and its text when it was kept. */
export interface SeedRecord {
  sha: string
  text?: string
}

/** path -> what Holi last wrote there. */
export type SeedState = Record<string, SeedRecord>

export const sha256 = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex')

/** Never throws: a corrupt state file reads as empty, which hands every
 *  diverged file to the agent rather than merging against a wrong base. */
export async function readSeedState(root: string): Promise<SeedState> {
  const text = await readFile(join(root, SEED_STATE_FILE), 'utf8').catch(() => null)
  if (text === null) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const state: SeedState = {}
    for (const [rel, value] of Object.entries(parsed as Record<string, unknown>)) {
      // An older record is the bare hash.
      if (typeof value === 'string') state[rel] = { sha: value }
      else if (typeof value === 'object' && value !== null) {
        const { sha, text: kept } = value as Record<string, unknown>
        if (typeof sha !== 'string') continue
        state[rel] = typeof kept === 'string' ? { sha, text: kept } : { sha }
      }
    }
    return state
  } catch {
    return {}
  }
}

/** Remember that Holi wrote exactly `content` at `rel`. */
export async function recordSeeded(root: string, rel: string, content: string): Promise<void> {
  const state = await readSeedState(root)
  state[rel] = { sha: sha256(content), text: content }
  await writeAtomic(root, vaultRelPath(SEED_STATE_FILE), JSON.stringify(state, null, 2) + '\n')
}

/** Is `onDisk` still exactly what the record says Holi wrote? */
export const untouched = (record: SeedRecord | undefined, onDisk: string): boolean =>
  record !== undefined && record.sha === sha256(onDisk)
