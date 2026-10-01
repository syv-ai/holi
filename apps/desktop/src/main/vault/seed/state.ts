/**
 * What Holi seeded, so an update can tell what the vault changed.
 *
 * Holi's skills and hooks are the vault's files from the moment they are
 * written. `holi skills update` brings a newer shipped version to them, and to
 * do that without losing the vault's own edits it needs the **base**: the text
 * Holi seeded there. With it, an untouched file is replaced, an edited one is
 * 3-way merged, and only a real conflict needs an agent.
 *
 * It also remembers which plugins this machine has seen enabled in the
 * vault, so a plugin's shipped files are written once when it is first turned
 * on here, and a skill the vault later deleted stays deleted.
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
import { writeAtomic } from '../vault-files'

export const SEED_STATE_FILE = '.holi/state/seed-state.local.json'

/** What Holi wrote at one path: its text, and its hash. */
export interface SeedRecord {
  sha: string
  text: string
}

export interface SeedState {
  /** Path to what Holi last wrote there. */
  files: Record<string, SeedRecord>
  /**
   * Every plugin this machine has seen enabled in the vault: the baseline a
   * newly enabled one is told apart by. Absent until the vault is first
   * seeded here.
   */
  plugins?: string[]
}

export const sha256 = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex')

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Never throws: a corrupt state file reads as empty, which hands every
 *  diverged file to the agent rather than merging against a wrong base. */
export async function readSeedState(root: string): Promise<SeedState> {
  const text = await readFile(join(root, SEED_STATE_FILE), 'utf8').catch(() => null)
  const state: SeedState = { files: {} }
  if (text === null) return state
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return state
  }
  if (!isObject(parsed)) return state
  if (isObject(parsed.files)) {
    for (const [rel, record] of Object.entries(parsed.files)) {
      if (isObject(record) && typeof record.sha === 'string' && typeof record.text === 'string') {
        state.files[rel] = { sha: record.sha, text: record.text }
      }
    }
  }
  if (Array.isArray(parsed.plugins)) {
    state.plugins = parsed.plugins.filter((id): id is string => typeof id === 'string')
  }
  return state
}

async function writeSeedState(root: string, state: SeedState): Promise<void> {
  await writeAtomic(root, vaultRelPath(SEED_STATE_FILE), JSON.stringify(state, null, 2) + '\n')
}

/** Remember that Holi wrote exactly `content` at `rel`. */
export async function recordSeeded(root: string, rel: string, content: string): Promise<void> {
  const state = await readSeedState(root)
  state.files[rel] = { sha: sha256(content), text: content }
  await writeSeedState(root, state)
}

/** Remember the plugins this machine has now seen enabled in the vault. */
export async function recordPlugins(root: string, ids: readonly string[]): Promise<void> {
  const state = await readSeedState(root)
  state.plugins = [...new Set(ids)].sort()
  await writeSeedState(root, state)
}

/** Is `onDisk` still exactly what the record says Holi wrote? */
export const untouched = (record: SeedRecord | undefined, onDisk: string): boolean =>
  record !== undefined && record.sha === sha256(onDisk)
