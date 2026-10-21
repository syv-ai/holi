/**
 * What an agent turn changed, as two commit shas.
 *
 * **The record is a range and nothing else.** No path list, no content, no
 * queue: `base` at turn start, `end` where it ended, and the files
 * come from `git diff base..end` when someone asks. Storing paths as well would
 * duplicate what git holds, and go stale.
 *
 * **`.local.`, so it never syncs**. A turn happened on this machine, not
 * in the vault's content.
 *
 * **A broken log must never break a turn.** Every read failure answers `[]`, and
 * every write is best-effort at the call site: the turn bracket this hangs off
 * also resumes sync, and a lost record beats a vault left paused.
 *
 * No Electron import: this loads under plain Node like the rest of the plugin.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Machine state, with the rest of it under `state/`. Gitignored by the
 *  `.local.` marker. */
export const TURNS_FILE = '.holi/state/turns.local.json'

export interface TurnRecord {
  /** HEAD when the turn started. */
  base: string
  /** HEAD after the turn's settle commit. For a turn that ended while another
   *  session's was still running, so no commit could land, a tree object of the
   *  working tree instead (`worktree-end.ts`). Either is something `git diff`
   *  and `git show <end>:<path>` take. */
  end: string
  /** ISO timestamp of the turn's end. */
  at: string
  /** Which of the vault's agent sessions ran it. May be absent. */
  sessionId?: string
  /** Another session's turn was open at the same instant, so this range contains
   *  work this turn did not do. Absent reads as false. */
  overlapped?: boolean
}

export interface TurnLog {
  /** Newest first, capped. `[]` for a vault that has never run a turn, and for
   *  an unreadable or malformed file. */
  list(): Promise<TurnRecord[]>
  /** Prepend and cap. A turn that changed nothing (`base` equals `end`) is kept:
   *  it still ends the session's turn, which is where the prompt hook's "changed
   *  since your last turn" starts counting. The chip skips it. It replaces that
   *  session's previous one, so a chatty session cannot push real turns out of
   *  the cap. */
  append(record: TurnRecord): Promise<void>
}

/** Enough to look back over a working day, and small enough that the whole file
 *  is read and rewritten on each append without anyone noticing. */
const CAP = 50

/** The three required fields only: `sessionId` and `overlapped` are optional. */
function isRecord(value: unknown): value is TurnRecord {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    typeof r['base'] === 'string' && typeof r['end'] === 'string' && typeof r['at'] === 'string'
  )
}

export function openTurnLog(vaultRoot: string): TurnLog {
  const path = join(vaultRoot, TURNS_FILE)

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
    const noChange = (r: TurnRecord): boolean =>
      r.base === r.end && r.sessionId !== undefined && r.sessionId === record.sessionId
    let previous = await list()
    if (noChange(record)) previous = previous.filter((r) => !noChange(r))
    const next = [record, ...previous].slice(0, CAP)
    // A freshly cloned vault may have no `.holi/` yet.
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  }

  return { list, append }
}
