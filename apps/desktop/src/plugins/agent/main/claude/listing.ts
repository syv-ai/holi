/**
 * What Claude Code says about a vault's sessions.
 *
 * A session is a Claude Code **background session**: its supervisor runs it,
 * its short job id names it, and `claude agents --json` is the supported way to
 * read it. The id is the key everywhere in Holi. It survives `/clear`, which
 * changes the conversation's `sessionId`, and it is what `attach`, `stop` and
 * `respawn` take.
 *
 * **The command, never the files.** State lives under `$CLAUDE_CONFIG_DIR`
 * in `jobs/<id>/` and `sessions/<pid>.json`, and neither is a stable interface.
 * So the directories are an **edge trigger**: `watchConfigDir` says *something
 * moved*, and the listing says *what*. A turn ending touches both; a stop, or
 * the supervisor retiring an idle process, touches only `sessions/`.
 *
 * No Electron import: this loads under plain Node like the rest of the plugin.
 */
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

/** Claude Code's live statuses. `waiting` is the one Holi shows as needs-you;
 *  `shell` is a shell command running, which is working. */
const STATUSES = ['busy', 'waiting', 'idle', 'shell'] as const
export type ClaudeStatus = (typeof STATUSES)[number]

export interface ClaudeRow {
  /** The short job id: the key. */
  id: string
  /** The conversation's full id, which `/clear` changes. Read at the moment
   *  it is used (a fork), never stored. */
  sessionId?: string
  /** Claude Code's name for it. An unnamed session is listed under its id. */
  name: string
  /** Present only while its process is alive. */
  pid?: number
  status?: ClaudeStatus
  /** Only when `status` is `waiting`: `permission prompt`, `input needed`… */
  waitingFor?: string
  /** `working | blocked | done | failed | stopped`. Kept as text: Holi reads
   *  `status` for what a live session is doing. */
  state?: string
}

/** What the renderer is told a session is doing. */
export type SessionState = 'needs-you' | 'working' | 'idle'

export interface SessionSummary {
  id: string
  /** Claude Code's name, else 'New session'. */
  name: string
  state: SessionState
  /** Present only for 'needs-you', when Claude Code says why. */
  waitingFor?: string
  /** How much of its context window is used, 0 to 100, from its status line.
   *  Absent until Claude Code has said, and again after a `/clear`. */
  contextPercent?: number
  /** Started from the quick panel this run (docs/features/quick-agent.md):
   *  its questions come to Holi as cards. */
  quick?: true
}

const NEW_SESSION = 'New session'

function isStatus(value: unknown): value is ClaudeStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
}

/** The root itself, or somewhere under it: a session may have moved into a
 *  subdirectory, and a row for another tree is never ours to act on. */
function isUnder(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/** One row, or null. Row by row: a shape we do not recognise costs that
 *  session, not every session. */
function toRow(value: unknown, vaultRoot: string): ClaudeRow | null {
  if (value === null || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (r['kind'] !== 'background') return null
  if (typeof r['cwd'] !== 'string' || !isUnder(r['cwd'], vaultRoot)) return null
  if (typeof r['id'] !== 'string' || r['id'] === '') return null
  const pid = typeof r['pid'] === 'number' && Number.isInteger(r['pid']) ? r['pid'] : undefined
  return {
    id: r['id'],
    name: typeof r['name'] === 'string' ? r['name'] : '',
    ...(typeof r['sessionId'] === 'string' ? { sessionId: r['sessionId'] } : {}),
    ...(pid === undefined ? {} : { pid }),
    ...(isStatus(r['status']) ? { status: r['status'] } : {}),
    ...(typeof r['waitingFor'] === 'string' ? { waitingFor: r['waitingFor'] } : {}),
    ...(typeof r['state'] === 'string' ? { state: r['state'] } : {}),
  }
}

/** The vault's background sessions out of `claude agents --json`. Every
 *  failure, including a null listing, is an empty answer. */
export function parseListing(stdout: string | null, vaultRoot: string): ClaudeRow[] {
  if (stdout === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map((entry) => toRow(entry, vaultRoot)).filter((r): r is ClaudeRow => r !== null)
}

/** Is its process alive? Only these are in the sidebar; the rest live in the
 *  agent view's history. */
export function isLive(row: ClaudeRow): boolean {
  return row.pid !== undefined
}

/**
 * What a live session is doing.
 *
 * From `status`, never from `state`: a session started with no prompt reads
 * `state: blocked` while it simply waits for one, and that is not needs-you.
 * The hook bracket (`working`) is the floor under a listing that is slow or
 * too old to answer.
 */
export function summarise(
  row: ClaudeRow,
  working: ReadonlySet<string>,
  contextPercent?: number,
): SessionSummary {
  let state: SessionState = 'idle'
  if (row.status === 'waiting') state = 'needs-you'
  else if (row.status === 'busy' || row.status === 'shell' || working.has(row.id)) state = 'working'
  const name = row.name === '' || row.name === row.id ? NEW_SESSION : row.name
  return {
    id: row.id,
    name,
    state,
    ...(state === 'needs-you' && row.waitingFor !== undefined
      ? { waitingFor: row.waitingFor }
      : {}),
    ...(contextPercent === undefined ? {} : { contextPercent }),
  }
}

/**
 * How much of a session's context window is used, 0 to 100 and rounded, from
 * the JSON Claude Code hands its `statusLine` command. A documented
 * channel, which is why Holi reads it and not the transcript. Null before the
 * first message and after a `/clear`, and for any shape it does not recognise:
 * it is another program's output.
 */
export function readContextPercent(status: unknown): number | null {
  if (status === null || typeof status !== 'object') return null
  const window = (status as Record<string, unknown>)['context_window']
  if (window === null || typeof window !== 'object') return null
  const used = (window as Record<string, unknown>)['used_percentage']
  return typeof used === 'number' && Number.isFinite(used)
    ? Math.min(100, Math.max(0, Math.round(used)))
    : null
}

/** The directories Claude Code keeps session state in, under the config dir. */
export const WATCHED_DIRS = ['sessions', 'jobs'] as const

/** Bursts are normal: rows carry heartbeat fields that move on their own. */
const WATCH_DEBOUNCE_MS = 150
/** Holi creates the config dir before a session runs; this covers the gap. */
const WATCH_RETRY_MS = 500

/** True for a path under one of `WATCHED_DIRS`, or one of them itself. A
 *  watcher that cannot name the file is taken at its word that something moved. */
function isWatched(filename: string | null): boolean {
  if (filename === null) return true
  const top = filename.split(/[/\\]/, 1)[0]
  return (WATCHED_DIRS as readonly string[]).includes(top ?? '')
}

/**
 * Call `onChange` when the config directory's session state moves. Debounced,
 * retried until the directory exists. The returned function stops it all.
 *
 * One recursive watch on the config dir, filtered to `WATCHED_DIRS`, rather
 * than one per directory. On macOS every directory `fs.watch` in a process
 * shares a single FSEvents stream, and adding a second path rebuilds that
 * stream, dropping whatever the first had buffered: changes made just after a
 * two-handle watch began were lost about one time in three. One handle also
 * reports `sessions/` and `jobs/` appearing, which Claude Code creates on
 * first use.
 */
export function watchConfigDir(
  configDir: string,
  onChange: () => void,
  log: (msg: string) => void = (msg) => console.log(`[claude-sessions] ${msg}`),
): () => void {
  let debounce: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let watcher: FSWatcher | null = null
  let retry: ReturnType<typeof setTimeout> | null = null

  const fire = (): void => {
    if (debounce !== null) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      onChange()
    }, WATCH_DEBOUNCE_MS)
  }

  const attach = (retried: boolean): void => {
    retry = null
    if (stopped) return
    try {
      watcher = watch(configDir, { recursive: true }, (_event, filename) => {
        if (isWatched(filename)) fire()
      })
      watcher.on('error', (err) => log(`watch failed: ${String(err)}`))
      // The directory appearing is itself news nothing else will report.
      if (retried) fire()
    } catch {
      retry = setTimeout(() => attach(true), WATCH_RETRY_MS)
    }
  }
  attach(false)

  return () => {
    stopped = true
    if (debounce !== null) clearTimeout(debounce)
    if (retry !== null) clearTimeout(retry)
    watcher?.close()
    watcher = null
  }
}
