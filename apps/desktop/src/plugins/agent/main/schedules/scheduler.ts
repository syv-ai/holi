/**
 * Scheduled agents (docs/features/scheduled-agents.md): a file in the vault
 * says what and when, and Holi starts a background session at those times on
 * this machine while the vault is open.
 *
 * **The definition is a vault file; running it is this machine's choice.** A
 * schedule file syncs like any other, so a teammate's pull brings it, but it
 * runs only where someone turned it on. Turning it on records a fingerprint of
 * what it approves (the prompt, the model, the rules it may run without
 * asking: `scheduleApprovalText`), and a schedule whose file no longer
 * matches waits to be turned on again. Otherwise a prompt edited by a pull,
 * or by the agent in one of its own runs, would run unattended unread.
 *
 * **The approvals live outside the vault**, in `userData`, for the same
 * reason: anything in the clone the agent can write, and an approval it could
 * write would be no approval.
 *
 * **One check every half minute** rather than a timer per schedule: a laptop
 * that sleeps through its runs wakes to a check, which finds the first missed
 * moment and runs once (`dueRun`), however many it missed.
 *
 * **A run is a session like any other**, named for its schedule, which the
 * sidebar lists and the turn bracket pauses sync for. A run does not start
 * while the previous one is still working or waiting on you; when the previous
 * one is idle and nobody has a window on it, it is stopped first, and stays in
 * the agents list. So each schedule holds at most one live session.
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  describeScheduleWhen,
  dueRun,
  isScheduleFilePath,
  nextRun,
  parseScheduleFile,
  scheduleApprovalText,
  scheduleSlug,
  SCHEDULES_DIR,
  type ScheduleDef,
} from '@holi/shared'
import { CapabilityError, type JsonFileStore } from '../../../../main/plugin-api'
import type { SessionSummary } from '../claude/listing'

/** How often the open vault's schedules are checked. */
const TICK_MS = 30_000
/** The first check after a vault opens, once the agent has attached. */
const FIRST_TICK_MS = 5_000
/** Runs remembered per schedule. */
const RUNS_KEPT = 20

export type RunTrigger = 'schedule' | 'manual'

export interface RunRecord {
  /** ISO time it was due to start, or asked to. */
  at: string
  trigger: RunTrigger
  outcome: 'started' | 'skipped' | 'failed'
  /** The session it started. */
  jobId?: string
  /** Why it was skipped or failed. */
  message?: string
}

export interface ScheduleState {
  /** sha256 of `scheduleApprovalText` when it was turned on. */
  approved?: string
  /** ISO time it was turned on: the first run looks for moments after it. */
  approvedAt?: string
  /** ISO time of the last run, started or skipped. */
  lastRun?: string
  /** Newest first. */
  runs: RunRecord[]
}

/** Every vault's schedules on this machine: remote, then schedule path. */
export type SchedulesFile = Record<string, Record<string, ScheduleState>>

/** `on`: runs here. `off`: never turned on, or turned off. `changed`: turned
 *  on, but the file approves something else now. `invalid`: does not parse. */
export type ScheduleStatus = 'on' | 'off' | 'changed' | 'invalid'

export interface ScheduleSummary {
  path: string
  /** What the CLI takes: the file's name without `.md` or `.local`. */
  slug: string
  name: string
  status: ScheduleStatus
  /** Why it does not parse. */
  error?: string
  /** When it runs, in words. */
  when?: string
  model?: string
  allow?: string[]
  prompt?: string
  /** ISO time of the next run, while it is on. */
  nextRun?: string
  lastRun?: string
  runs: RunRecord[]
  /** The latest run's session, while it is alive. */
  live?: { id: string; state: SessionSummary['state'] }
}

/** The file on disk, read leniently: a hand edit gone wrong costs the entries
 *  it broke, not every vault's. */
export function parseSchedulesFile(raw: unknown): SchedulesFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: SchedulesFile = {}
  for (const [remote, vault] of Object.entries(raw as Record<string, unknown>)) {
    if (vault === null || typeof vault !== 'object' || Array.isArray(vault)) continue
    const schedules: Record<string, ScheduleState> = {}
    for (const [path, value] of Object.entries(vault as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const v = value as Record<string, unknown>
      const runs = Array.isArray(v['runs'])
        ? (v['runs'] as unknown[]).filter(
            (r): r is RunRecord =>
              r !== null &&
              typeof r === 'object' &&
              typeof (r as RunRecord).at === 'string' &&
              typeof (r as RunRecord).outcome === 'string',
          )
        : []
      schedules[path] = {
        ...(typeof v['approved'] === 'string' ? { approved: v['approved'] } : {}),
        ...(typeof v['approvedAt'] === 'string' ? { approvedAt: v['approvedAt'] } : {}),
        ...(typeof v['lastRun'] === 'string' ? { lastRun: v['lastRun'] } : {}),
        runs,
      }
    }
    out[remote] = schedules
  }
  return out
}

export interface SchedulerVault {
  remote: string
  root: string
}

export interface SchedulerDeps {
  store: JsonFileStore<SchedulesFile>
  /** The open vault's sessions. */
  sessions: {
    launch(args: {
      name: string
      prompt: string
      model?: string
      allow?: readonly string[]
    }): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }>
    sessions(): SessionSummary[]
    stop(id: string): Promise<{ ok: true } | { ok: false; message: string }>
    watched(id: string): boolean
  }
  /** Tell the renderer the vault's schedules moved. */
  emit(remote: string, name: string, payload: unknown): void
  now?: () => Date
  tickMs?: number
  firstTickMs?: number
  log?: (msg: string) => void
}

export interface Scheduler {
  /** Start checking the vault's schedules; until `detach`, this is the vault
   *  that runs. */
  attach(vault: SchedulerVault): void
  detach(): void
  list(vault: SchedulerVault): Promise<ScheduleSummary[]>
  /** Turn a schedule on here, approving what its file says now. */
  enable(vault: SchedulerVault, ref: string): Promise<ScheduleSummary>
  disable(vault: SchedulerVault, ref: string): Promise<ScheduleSummary>
  /** Run an approved schedule now, whatever its times say. */
  run(vault: SchedulerVault, ref: string): Promise<RunRecord>
  /** One check, as the timer runs it. */
  tick(): Promise<void>
}

interface FileEntry {
  path: string
  parsed: ReturnType<typeof parseScheduleFile>
}

const fingerprint = (def: ScheduleDef): string =>
  createHash('sha256').update(scheduleApprovalText(def)).digest('hex')

/** The vault's schedule files, parsed. A missing directory is none. Only
 *  regular files: a link could point a schedule at anything. */
async function readSchedules(root: string): Promise<FileEntry[]> {
  const dir = join(root, SCHEDULES_DIR)
  const names = await readdir(dir).catch(() => [] as string[])
  const out: FileEntry[] = []
  for (const name of names.sort()) {
    const path = `${SCHEDULES_DIR}/${name}`
    if (!isScheduleFilePath(path)) continue
    const abs = join(dir, name)
    const info = await lstat(abs).catch(() => null)
    if (info === null || !info.isFile()) continue
    const text = await readFile(abs, 'utf8').catch(() => null)
    if (text === null) continue
    out.push({ path, parsed: parseScheduleFile(text, path) })
  }
  return out
}

function statusOf(entry: FileEntry, state: ScheduleState | undefined): ScheduleStatus {
  if (!entry.parsed.ok) return 'invalid'
  if (state?.approved === undefined) return 'off'
  return state.approved === fingerprint(entry.parsed.def) ? 'on' : 'changed'
}

/** One schedule by its path or its slug. A slug two files share (`x.md` and
 *  `x.local.md`) names neither. */
function find(entries: readonly FileEntry[], ref: string): FileEntry {
  const byPath = entries.find((e) => e.path === ref)
  if (byPath !== undefined) return byPath
  const bySlug = entries.filter((e) => scheduleSlug(e.path) === ref)
  if (bySlug.length === 1) return bySlug[0]!
  if (bySlug.length > 1) {
    throw new CapabilityError(
      'BAD_REQUEST',
      `${ref} names ${bySlug.map((e) => e.path).join(' and ')}: give the path`,
    )
  }
  throw new CapabilityError('NOT_FOUND', `No schedule ${ref} in ${SCHEDULES_DIR}/`)
}

const pad = (n: number): string => String(n).padStart(2, '0')
const clock = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const localTime = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(d)}`

/**
 * The run's first turn: one line of where it comes from, then the file's
 * prompt. The previous run's time is what lets a prompt say "since last time"
 * (mail, a feed) without keeping a record of its own.
 */
export function runPrompt(
  def: ScheduleDef,
  path: string,
  now: Date,
  previous: Date | null,
): string {
  const before = previous === null ? 'this is its first run' : `previous run ${localTime(previous)}`
  return `Scheduled run of "${def.name}" (${path}), ${localTime(now)}; ${before}.\n\n${def.prompt}`
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? ((msg: string) => console.log(`[schedules] ${msg}`))
  let attached: SchedulerVault | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let first: ReturnType<typeof setTimeout> | null = null
  /** Schedules starting a run now, by path: a slow start must not start two. */
  const firing = new Set<string>()
  let ticking: Promise<void> | null = null

  const stateOf = async (remote: string): Promise<Record<string, ScheduleState>> =>
    (await deps.store.read())[remote] ?? {}

  const changeState = (
    remote: string,
    path: string,
    change: (s: ScheduleState) => ScheduleState,
  ): Promise<SchedulesFile> =>
    deps.store.update((file) => {
      const vault = { ...(file[remote] ?? {}) }
      vault[path] = change(vault[path] ?? { runs: [] })
      return { ...file, [remote]: vault }
    })

  const changed = (remote: string): void => deps.emit(remote, 'schedules', null)

  function summarise(
    entry: FileEntry,
    state: ScheduleState | undefined,
    live: readonly SessionSummary[],
    at: Date,
  ): ScheduleSummary {
    const status = statusOf(entry, state)
    const runs = state?.runs ?? []
    const latest = runs.find((r) => r.jobId !== undefined)
    const session = latest === undefined ? undefined : live.find((s) => s.id === latest.jobId)
    const base = {
      path: entry.path,
      slug: scheduleSlug(entry.path),
      status,
      runs,
      ...(state?.lastRun === undefined ? {} : { lastRun: state.lastRun }),
      ...(session === undefined ? {} : { live: { id: session.id, state: session.state } }),
    }
    if (!entry.parsed.ok)
      return { ...base, name: scheduleSlug(entry.path), error: entry.parsed.error }
    const def = entry.parsed.def
    const next = status === 'on' ? nextRun(def.when, at) : null
    return {
      ...base,
      name: def.name,
      when: describeScheduleWhen(def.when),
      ...(def.model === undefined ? {} : { model: def.model }),
      allow: def.allow,
      prompt: def.prompt,
      ...(next === null ? {} : { nextRun: next.toISOString() }),
    }
  }

  async function list(vault: SchedulerVault): Promise<ScheduleSummary[]> {
    const [entries, state] = await Promise.all([readSchedules(vault.root), stateOf(vault.remote)])
    const live = attached?.remote === vault.remote ? deps.sessions.sessions() : []
    const at = now()
    return entries.map((e) => summarise(e, state[e.path], live, at))
  }

  async function one(vault: SchedulerVault, path: string): Promise<ScheduleSummary> {
    const found = (await list(vault)).find((s) => s.path === path)
    if (found === undefined) throw new CapabilityError('NOT_FOUND', `${path} is gone`)
    return found
  }

  /** Start one run of `entry`, recording what happened. */
  async function fire(
    vault: SchedulerVault,
    entry: FileEntry & { parsed: { ok: true; def: ScheduleDef } },
    trigger: RunTrigger,
    due: Date,
  ): Promise<RunRecord> {
    const def = entry.parsed.def
    const at = now()
    const state = (await stateOf(vault.remote))[entry.path]
    const previous = state?.runs.find((r) => r.outcome === 'started')
    let record: RunRecord
    const prior =
      previous?.jobId === undefined
        ? undefined
        : deps.sessions.sessions().find((s) => s.id === previous.jobId)
    if (prior !== undefined && prior.state !== 'idle') {
      record = {
        at: due.toISOString(),
        trigger,
        outcome: 'skipped',
        message:
          prior.state === 'needs-you'
            ? 'The previous run is waiting on you.'
            : 'The previous run is still working.',
      }
    } else {
      // Done, and nobody is reading it: out of the sidebar, into the list.
      if (prior !== undefined && !deps.sessions.watched(prior.id)) {
        await deps.sessions.stop(prior.id)
      }
      const res = await deps.sessions.launch({
        name: `${def.name} · ${clock(at)}`,
        prompt: runPrompt(
          def,
          entry.path,
          at,
          previous === undefined ? null : new Date(previous.at),
        ),
        ...(def.model === undefined ? {} : { model: def.model }),
        allow: def.allow,
      })
      record = res.ok
        ? { at: at.toISOString(), trigger, outcome: 'started', jobId: res.sessionId }
        : { at: at.toISOString(), trigger, outcome: 'failed', message: res.message }
    }
    await changeState(vault.remote, entry.path, (s) => ({
      ...s,
      lastRun: at.toISOString(),
      runs: [record, ...s.runs].slice(0, RUNS_KEPT),
    }))
    log(`${entry.path}: ${record.outcome}${record.message ? ` (${record.message})` : ''}`)
    changed(vault.remote)
    return record
  }

  async function tickNow(): Promise<void> {
    const vault = attached
    if (vault === null) return
    const [entries, state] = await Promise.all([readSchedules(vault.root), stateOf(vault.remote)])
    const at = now()
    for (const entry of entries) {
      if (!entry.parsed.ok || firing.has(entry.path)) continue
      const s = state[entry.path]
      if (statusOf(entry, s) !== 'on') continue
      const since = new Date(s?.lastRun ?? s?.approvedAt ?? at.toISOString())
      const due = dueRun(entry.parsed.def.when, since, at)
      if (due === null) continue
      if (attached !== vault) return
      firing.add(entry.path)
      try {
        await fire(
          vault,
          entry as FileEntry & { parsed: { ok: true; def: ScheduleDef } },
          'schedule',
          due,
        )
      } catch (err) {
        log(`${entry.path}: run failed: ${String(err)}`)
      } finally {
        firing.delete(entry.path)
      }
    }
  }

  return {
    attach(vault) {
      this.detach()
      attached = vault
      first = setTimeout(() => {
        first = null
        void this.tick()
      }, deps.firstTickMs ?? FIRST_TICK_MS)
      timer = setInterval(() => void this.tick(), deps.tickMs ?? TICK_MS)
    },

    detach() {
      attached = null
      if (timer !== null) clearInterval(timer)
      if (first !== null) clearTimeout(first)
      timer = null
      first = null
    },

    list,

    async enable(vault, ref) {
      const entry = find(await readSchedules(vault.root), ref)
      if (!entry.parsed.ok) {
        throw new CapabilityError(
          'BAD_REQUEST',
          `${entry.path} does not parse: ${entry.parsed.error}`,
        )
      }
      const def = entry.parsed.def
      const at = now()
      if (def.when.kind === 'at' && def.when.local.getTime() <= at.getTime()) {
        throw new CapabilityError(
          'BAD_REQUEST',
          `${entry.path} was for ${def.when.stamp}, which has passed`,
        )
      }
      await changeState(vault.remote, entry.path, (s) => ({
        ...s,
        approved: fingerprint(def),
        approvedAt: at.toISOString(),
        // Turned on now: the moments before this are not missed runs.
        lastRun: at.toISOString(),
      }))
      changed(vault.remote)
      return one(vault, entry.path)
    },

    async disable(vault, ref) {
      const entry = find(await readSchedules(vault.root), ref)
      await changeState(vault.remote, entry.path, (s) => ({
        runs: s.runs,
        ...(s.lastRun === undefined ? {} : { lastRun: s.lastRun }),
      }))
      changed(vault.remote)
      return one(vault, entry.path)
    },

    async run(vault, ref) {
      if (attached?.remote !== vault.remote) {
        throw new CapabilityError('UNAVAILABLE', 'That vault is not open.')
      }
      const entries = await readSchedules(vault.root)
      const entry = find(entries, ref)
      const status = statusOf(entry, (await stateOf(vault.remote))[entry.path])
      if (!entry.parsed.ok) {
        throw new CapabilityError(
          'BAD_REQUEST',
          `${entry.path} does not parse: ${entry.parsed.error}`,
        )
      }
      if (status !== 'on') {
        throw new CapabilityError(
          'FORBIDDEN',
          status === 'changed'
            ? `${entry.path} changed since it was turned on. Turn it on again to approve it.`
            : `${entry.path} is off on this machine. Turn it on first.`,
        )
      }
      if (firing.has(entry.path)) {
        throw new CapabilityError('BAD_REQUEST', `${entry.path} is starting a run already.`)
      }
      firing.add(entry.path)
      try {
        return await fire(
          vault,
          entry as FileEntry & { parsed: { ok: true; def: ScheduleDef } },
          'manual',
          now(),
        )
      } finally {
        firing.delete(entry.path)
      }
    },

    async tick() {
      // One check at a time: a slow start must not overlap the next tick.
      if (ticking !== null) return ticking
      ticking = tickNow().catch((err: unknown) => log(`check failed: ${String(err)}`))
      try {
        await ticking
      } finally {
        ticking = null
      }
    },
  }
}
