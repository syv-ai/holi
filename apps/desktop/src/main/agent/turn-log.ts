/**
 * What an agent turn changed, as two commit shas (D88).
 *
 * **The record is a range and nothing else.** No path list, no content, no
 * queue: `base` at turn start, `end` at the turn's settle commit, and the files
 * come from `git diff base..end` when someone asks. Storing the paths as well
 * would be a second copy of an answer git already holds, and one that goes stale
 * the moment anything else touches the tree.
 *
 * **`.local.`, so it never syncs.** A turn is a thing that happened on this
 * machine; a teammate pulling your agent's turn boundaries would be reading your
 * session, not the vault's content. D65's marker plus the seeded `*.local.*`
 * ignore do the whole of that.
 *
 * **A broken log must never break a turn.** Every read failure — missing,
 * unparseable, hand-edited into nonsense — answers `[]`, and every write is
 * best-effort at the call site. The turn bracket this hangs off also resumes
 * sync, and losing a record is a smaller failure than a vault left paused.
 *
 * No Electron import: this loads under plain Node like the rest of `agent/`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface TurnRecord {
  /** HEAD when the turn started. */
  base: string
  /** HEAD after the turn's settle commit. */
  end: string
  /** ISO timestamp of the turn's end. */
  at: string
}

export interface TurnLog {
  /** Newest first, capped. `[]` for a vault that has never run a turn, and for
   *  an unreadable or malformed file. */
  list(): Promise<TurnRecord[]>
  /** Prepend and cap. A record whose `base` equals its `end` is dropped here, so
   *  no caller has to ask whether a turn changed anything. */
  append(record: TurnRecord): Promise<void>
}

/** Enough to look back over a working day, and small enough that the whole file
 *  is read and rewritten on each append without anyone noticing. */
const CAP = 50

function isRecord(value: unknown): value is TurnRecord {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return typeof r['base'] === 'string' && typeof r['end'] === 'string' && typeof r['at'] === 'string'
}

export function openTurnLog(vaultRoot: string): TurnLog {
  const path = join(vaultRoot, '.holi', 'turns.local.json')

  const list = async (): Promise<TurnRecord[]> => {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      return []
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      // Entry by entry rather than all-or-nothing: one hand-edited record should
      // not lose the rest of the day.
      return Array.isArray(parsed) ? parsed.filter(isRecord).slice(0, CAP) : []
    } catch {
      return []
    }
  }

  const append = async (record: TurnRecord): Promise<void> => {
    // A turn that committed nothing is not a turn worth reviewing, and the chip
    // that would announce it would have nothing to open.
    if (record.base === record.end) return
    const next = [record, ...(await list())].slice(0, CAP)
    // A freshly cloned vault may have no `.holi/` yet.
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  }

  return { list, append }
}
