/**
 * `archive-done` — move long-finished tasks under `archive/`, links and all.
 *
 * **Off by default** (see the seeded `.holi/settings/app.json`). It moves task
 * files, which changes what the board shows, and a transform that rearranges
 * someone's work has to be asked for rather than assumed.
 *
 * **The completion date comes from git.** `Task` carries no `completedAt`, and
 * mtime is reset by a checkout — so the last commit that touched the file is
 * the only durable answer available. It is an approximation: the file's last
 * commit is when it was last *edited*, which for a done task is normally the
 * commit that marked it done, but is not guaranteed to be. The log line says
 * which clock was used so the approximation is legible rather than implied.
 *
 * The link rewrite is not optional. `sweepDaily` has a backref guard for
 * exactly this: a moved file with a stranded `[[link]]` is the harm, and there
 * is no orphan-rescue net in this vault.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { isTaskFilePath, parseTaskFile, vaultRelPath } from '@holi/shared'
import { absPathFor, listFiles } from '../vault-files'
import { moveNotes } from '../move'
import type { StagedChanges } from './staged'
import type { TransformResult } from './relink'

const exec = promisify(execFile)

/** Where finished work goes. A prefix rather than a sibling folder per area, so
 *  the original path survives inside it and a task can be found where it was. */
export const ARCHIVE_DIR = 'archive'

/** A task done this morning is still what the user is looking at. Two weeks is
 *  long enough that nobody is mid-thought about it, and short enough that the
 *  board does not fill with finished work. */
const DEFAULT_THRESHOLD_DAYS = 14

export interface ArchiveOpts {
  thresholdDays?: number
  /** Injected so a test can ask "what about 30 days from now" without rewriting
   *  git's clock. */
  now?: Date
}

export async function archiveDone(
  root: string,
  _staged: StagedChanges,
  opts: ArchiveOpts = {},
): Promise<TransformResult> {
  const thresholdDays = opts.thresholdDays ?? DEFAULT_THRESHOLD_DAYS
  const now = opts.now ?? new Date()
  const cutoff = now.getTime() - thresholdDays * 24 * 60 * 60 * 1000

  const moves: { from: string; to: string }[] = []
  const notes: string[] = []

  for (const path of await listFiles(root)) {
    if (!isTaskFilePath(path)) continue
    // Never re-archive: a second pass would produce `archive/archive/…`, and
    // the path would grow a level on every run forever.
    if (path === ARCHIVE_DIR || path.startsWith(`${ARCHIVE_DIR}/`)) continue

    const text = await readFile(absPathFor(root, vaultRelPath(path)), 'utf8').catch(() => null)
    if (text === null) continue

    // `parseTaskFile` decides done-ness — never a regex over the text, and
    // never the filename. A file it refuses is not a task this transform gets
    // to have an opinion about.
    let done: boolean
    try {
      done = parseTaskFile(text, path).status === 'done'
    } catch {
      continue
    }
    if (!done) continue

    const finishedAt = await lastCommitTime(root, path)
    // No commit yet means git has no date for it: the task was created in the
    // working tree and has never been saved. Not old, by definition.
    if (finishedAt === null || finishedAt.getTime() > cutoff) continue

    moves.push({ from: path, to: `${ARCHIVE_DIR}/${path}` })
  }

  if (moves.length === 0) return { changed: [], notes: [] }

  // `moveNotes` moves the files AND rewrites every inbound `[[link]]` in one
  // read-all-then-write pass — the same primitive `relink` uses, and the reason
  // this transform does not hand-roll either half.
  const { rewritten } = await moveNotes(root, moves)

  notes.push(
    `archive-done: moved ${moves.length} task(s) finished more than ${thresholdDays} days ago ` +
      `(dated by each file's last commit, since a task carries no completion date)`,
  )

  /**
   * Everything the runner has to restage: both ends of each move — git needs to
   * see the deletion as well as the addition — **and every file whose inbound
   * links were rewritten**. Leaving those out is the subtle version of this bug:
   * the commit ships the moved task with the referring notes still pointing at
   * its old path, and the fix lands one commit later.
   */
  const changed = [
    ...new Set([
      ...moves.map((m) => m.from),
      ...moves.map((m) => m.to),
      ...rewritten.map((r) => r.path),
    ]),
  ].sort()
  return { changed, notes }
}

/** ISO time of the last commit touching `path`, or null if git has never seen
 *  it. `-1` so this is one cheap lookup rather than a walk. */
async function lastCommitTime(root: string, path: string): Promise<Date | null> {
  const { stdout } = await exec('git', ['log', '-1', '--format=%cI', '--', path], {
    cwd: root,
  }).catch(() => ({ stdout: '' }))
  const iso = stdout.trim()
  if (iso === '') return null
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : at
}
