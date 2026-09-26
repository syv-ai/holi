/**
 * What Holi last wrote, so it can tell its own file from an edited one (D75).
 *
 * Holi refreshes a managed file **only when it can prove nobody touched it**:
 * the sha256 of what it wrote, per path, compared against what is on disk now.
 * A hash that differs means a human or an agent changed the file: leave it, and
 * say so.
 *
 * **A hash rather than a version marker in the file.** A marker is visible,
 * can be edited around, and answers "which version" rather than "was this
 * touched".
 *
 * **Machine-local, and the `.local.` in the name is the whole enforcement**
 * (D65). A committed copy would travel to a teammate and claim their file was
 * untouched when Holi never wrote it there, which could destroy work.
 *
 * Only managed files are recorded. The hash exists to answer "may I overwrite
 * this?", and that question is never asked about `AGENTS.md`.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vaultRelPath } from '@holi/shared'
import { writeAtomic } from '../vault/vault-files'

export const SEED_STATE_FILE = '.holi/state/seed-state.local.json'

/** path -> sha256 of the content Holi wrote there. */
export type SeedState = Record<string, string>

const sha256 = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex')

/** Never throws: a corrupt state file reads as empty, which makes every managed
 *  file unrefreshable rather than making every one overwritable. The safe
 *  direction is the one that loses an improvement, not the one that loses an
 *  edit. */
export async function readSeedState(root: string): Promise<SeedState> {
  const text = await readFile(join(root, SEED_STATE_FILE), 'utf8').catch(() => null)
  if (text === null) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const state: SeedState = {}
    for (const [rel, hash] of Object.entries(parsed)) {
      if (typeof hash === 'string') state[rel] = hash
    }
    return state
  } catch {
    return {}
  }
}

/** Remember that Holi wrote exactly `content` at `rel`. */
export async function recordSeeded(root: string, rel: string, content: string): Promise<void> {
  const state = await readSeedState(root)
  state[rel] = sha256(content)
  await writeAtomic(root, vaultRelPath(SEED_STATE_FILE), JSON.stringify(state, null, 2) + '\n')
}

/**
 * May Holi overwrite `rel`, given what is on disk there now?
 *
 * **No record means no**, and that is the load-bearing case: a vault seeded
 * before the hashes existed would otherwise have its edited skills silently
 * rewritten.
 */
export async function mayRefresh(root: string, rel: string, onDisk: string): Promise<boolean> {
  const recorded = (await readSeedState(root))[rel]
  return recorded !== undefined && recorded === sha256(onDisk)
}
