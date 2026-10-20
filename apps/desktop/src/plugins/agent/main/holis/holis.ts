/**
 * Holis (docs/features/holis.md): agents that belong to the vault, which a
 * person sends work to. A Holi is a YAML file in `.holi/holis/` (who it is,
 * which documents it takes, what it may do without asking, its instructions);
 * sending it a document starts a Claude Code session on it, in an agent tab,
 * with the person there to answer its prompts.
 *
 * **The definition is a vault file; running it is this machine's choice.** A
 * Holi file syncs like any other, so a teammate's pull brings it, but nothing
 * runs it on this machine until its person approved what it says now: the
 * first send, and the first after its instructions, model, `allow` or
 * `accepts` changed, asks, and confirming records a fingerprint
 * (`holiApprovalText`). The scheduled agents' rule, for the same reason:
 * instructions edited by a pull, or by a run of the Holi itself, must not run
 * unread. The approvals live in `userData`, outside the clone the agent can
 * write, and `approve` opens only the UI door (`capabilities.ts`).
 *
 * **A send is a session like any other**: a background session (`claude
 * --bg`), attached in an agent tab. Who the Holi is and its instructions go in
 * with Claude Code's own `--append-system-prompt`; its first turn is one line
 * naming the document. Its turns pause sync and are recorded under its job id
 * like any session's, and its permission prompts are Claude Code's, answered in
 * the tab. **What came of it is the Holi's to say**, with `holi holis report`,
 * on the run's record, which the Holi's page shows beside what the run changed.
 * A report that asks for the person (`--needs-you`) is told where they are.
 *
 * A file with a `cron` or `at` is a **scheduled Holi**: shared vault work for
 * Claude Code's cloud. Holi cannot set those up there yet, so they are listed,
 * say so, and run nowhere (docs/not-built.md).
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  describeScheduleWhen,
  holiAccepts,
  holiApprovalText,
  holiIdOf,
  holiSlug,
  HOLIS_DIR,
  isHoliFilePath,
  parseHoliFile,
  serializeHoliFile,
  type HoliDef,
  type HoliDraft,
  type HoliMascot,
  type HoliParse,
} from '@holi/shared'
import { CapabilityError, type JsonFileStore } from '../../../../main/plugin-api'

/** Runs remembered per Holi. */
const RUNS_KEPT = 20
/** The longest report a run may leave: a line or two, not a document. */
const REPORT_MAX = 2_000

/** What every run may do without asking: say what came of it. */
const REPORT_RULE = 'Bash(holi holis report:*)'

/** What the Holi said came of a run (`holi holis report`). */
export interface RunReport {
  text: string
  at: string
  /** The Holi asked the person to act. */
  needsYou: boolean
}

/** One send: the session it started, and the document it took. */
export interface HoliRun {
  jobId: string
  /** ISO time it was sent. */
  at: string
  /** The document it was sent. */
  path: string
  report?: RunReport
}

export interface HoliState {
  /** sha256 of `holiApprovalText` when this machine approved it. */
  approved?: string
  /** Newest first. */
  runs: HoliRun[]
}

/** Every vault's Holis on this machine: remote, then file path. */
export type HolisFile = Record<string, Record<string, HoliState>>

/** `approved`: sends run at once. `new`: never approved here. `changed`:
 *  approved, but the file says something else now. `invalid`: does not
 *  parse. `cloud`: a scheduled Holi, which no machine runs. */
export type HoliStatus = 'approved' | 'new' | 'changed' | 'invalid' | 'cloud'

export interface HoliSummary {
  path: string
  /** What the CLI takes: the file's name without `.yaml` or `.local`. */
  id: string
  /** In a `.local.` file: this machine's alone. */
  local: boolean
  /** Sent work, or scheduled in the cloud. */
  kind: 'triggered' | 'scheduled'
  name: string
  status: HoliStatus
  /** Why it does not parse. */
  error?: string
  mascot?: HoliMascot
  color?: string
  description?: string
  model?: string
  accepts?: string[]
  /** A scheduled Holi's time, in words. */
  when?: string
  allow?: string[]
  instructions?: string
  /** Keys this build does not know: kept, ignored. */
  unknownKeys?: string[]
  /** What approving it approves, as the dialog shows it: `approve` takes it
   *  back and refuses if the file has changed since. */
  fingerprint?: string
  runs: HoliRun[]
}

/** The file on disk, read leniently: a hand edit gone wrong costs the entries
 *  it broke, not every vault's. */
export function parseHolisFile(raw: unknown): HolisFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: HolisFile = {}
  for (const [remote, vault] of Object.entries(raw as Record<string, unknown>)) {
    if (vault === null || typeof vault !== 'object' || Array.isArray(vault)) continue
    const holis: Record<string, HoliState> = {}
    for (const [path, value] of Object.entries(vault as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const v = value as Record<string, unknown>
      const runs = Array.isArray(v['runs'])
        ? (v['runs'] as unknown[]).filter(
            (r): r is HoliRun =>
              r !== null &&
              typeof r === 'object' &&
              typeof (r as HoliRun).jobId === 'string' &&
              typeof (r as HoliRun).at === 'string' &&
              typeof (r as HoliRun).path === 'string',
          )
        : []
      holis[path] = {
        ...(typeof v['approved'] === 'string' ? { approved: v['approved'] } : {}),
        runs,
      }
    }
    out[remote] = holis
  }
  return out
}

export interface HolisVault {
  remote: string
  root: string
}

/** A run's report that asks for the person: told where they are. */
export interface NeedsYou {
  remote: string
  id: string
  name: string
  text: string
}

export interface HolisDeps {
  store: JsonFileStore<HolisFile>
  /** The open vault's sessions. */
  sessions: {
    start(args: {
      name: string
      prompt: string
      model?: string
      allow?: readonly string[]
      appendSystemPrompt?: string
      cols?: number
      rows?: number
    }): Promise<
      { ok: true; sessionId: string; terminalId: string } | { ok: false; message: string }
    >
  }
  /** Tell the renderer the vault's Holis moved. */
  emit(remote: string, name: string, payload: unknown): void
  needsYou?(n: NeedsYou): void
  now?: () => Date
}

export interface SendResult {
  sessionId: string
  terminalId: string
}

export interface Holis {
  list(vault: HolisVault): Promise<HoliSummary[]>
  /** Approve what a Holi's file says now, on this machine: only if that is
   *  still the fingerprint the person was shown. */
  approve(vault: HolisVault, ref: string, seen: string): Promise<HoliSummary>
  /** Send a document to an approved Holi: a session on it, in an agent tab. */
  send(
    vault: HolisVault,
    ref: string,
    doc: { path: string; cols?: number; rows?: number },
  ): Promise<SendResult>
  /** Say what came of the Holi's latest run. */
  report(vault: HolisVault, ref: string, text: string, needsYou: boolean): Promise<HoliRun>
  /** Write a new Holi's file. */
  create(vault: HolisVault, draft: HoliDraft): Promise<HoliSummary>
}

interface FileEntry {
  path: string
  parsed: HoliParse
}

type ValidEntry = FileEntry & { parsed: { ok: true; def: HoliDef } }

const fingerprint = (def: HoliDef): string =>
  createHash('sha256').update(holiApprovalText(def)).digest('hex')

/** The vault's Holi files, parsed. A missing directory is none. Only regular
 *  files: a link could point a Holi at anything. */
async function readHolis(root: string): Promise<FileEntry[]> {
  const names = await readdir(join(root, HOLIS_DIR)).catch(() => [] as string[])
  const out: FileEntry[] = []
  for (const name of names.sort()) {
    const path = `${HOLIS_DIR}/${name}`
    if (!isHoliFilePath(path)) continue
    const abs = join(root, path)
    const info = await lstat(abs).catch(() => null)
    if (info === null || !info.isFile()) continue
    const text = await readFile(abs, 'utf8').catch(() => null)
    if (text !== null) out.push({ path, parsed: parseHoliFile(text, path) })
  }
  return out
}

function statusOf(entry: FileEntry, state: HoliState | undefined): HoliStatus {
  if (!entry.parsed.ok) return 'invalid'
  if (entry.parsed.def.when !== undefined) return 'cloud'
  if (state?.approved === undefined) return 'new'
  return state.approved === fingerprint(entry.parsed.def) ? 'approved' : 'changed'
}

/** One Holi by its path or its id. An id two files share (`x.yaml` and
 *  `x.local.yaml`) names neither. */
function find(entries: readonly FileEntry[], ref: string): FileEntry {
  const byPath = entries.find((e) => e.path === ref)
  if (byPath !== undefined) return byPath
  const byId = entries.filter((e) => holiIdOf(e.path) === ref)
  if (byId.length === 1) return byId[0]!
  if (byId.length > 1) {
    throw new CapabilityError(
      'BAD_REQUEST',
      `${ref} names ${byId.map((e) => e.path).join(' and ')}: give the path`,
    )
  }
  throw new CapabilityError('NOT_FOUND', `No Holi ${ref} in ${HOLIS_DIR}/`)
}

function valid(entry: FileEntry): ValidEntry {
  if (!entry.parsed.ok) {
    throw new CapabilityError('BAD_REQUEST', `${entry.path} does not parse: ${entry.parsed.error}`)
  }
  return entry as ValidEntry
}

/**
 * Who the Holi is and what it does, through Claude Code's own
 * `--append-system-prompt`: only what the approval covers (its id, its file
 * and its instructions), never its name or description, which anyone may
 * change without asking.
 */
export function holiSystemPrompt(def: HoliDef, path: string): string {
  return [
    `You are the Holi \`${def.id}\`, defined in ${path}. A person sent you a document from Holi and is here to answer your questions and permission prompts.`,
    `When you are done, say what came of it in a sentence or two with \`holi holis report ${def.id} "…"\` (add \`--needs-you\` if the person must act). If nothing came of it, report nothing.`,
    '',
    def.instructions,
  ].join('\n')
}

/** The send's first turn: the one line naming the document. */
export function sendPrompt(path: string): string {
  return `Work on ${path}.`
}

export function createHolis(deps: HolisDeps): Holis {
  const now = deps.now ?? (() => new Date())
  /** Holis starting a session now, by path: a double click must not start
   *  two. */
  const sending = new Set<string>()

  const stateOf = async (remote: string): Promise<Record<string, HoliState>> =>
    (await deps.store.read())[remote] ?? {}

  const changeState = (
    remote: string,
    path: string,
    change: (s: HoliState) => HoliState,
  ): Promise<HolisFile> =>
    deps.store.update((file) => {
      const vault = { ...(file[remote] ?? {}) }
      vault[path] = change(vault[path] ?? { runs: [] })
      return { ...file, [remote]: vault }
    })

  const changed = (remote: string): void => deps.emit(remote, 'holis', null)

  function summarise(entry: FileEntry, state: HoliState | undefined): HoliSummary {
    const base = {
      path: entry.path,
      id: holiIdOf(entry.path),
      local: entry.path.includes('.local.'),
      status: statusOf(entry, state),
      runs: state?.runs ?? [],
    }
    if (!entry.parsed.ok) {
      return { ...base, kind: 'triggered', name: base.id, error: entry.parsed.error }
    }
    const def = entry.parsed.def
    return {
      ...base,
      kind: def.when === undefined ? 'triggered' : 'scheduled',
      name: def.name,
      mascot: def.mascot,
      color: def.color,
      description: def.description,
      ...(def.model === undefined ? {} : { model: def.model }),
      accepts: def.accepts,
      ...(def.when === undefined ? {} : { when: describeScheduleWhen(def.when) }),
      allow: def.allow,
      instructions: def.instructions,
      unknownKeys: def.unknownKeys,
      fingerprint: fingerprint(def),
    }
  }

  async function list(vault: HolisVault): Promise<HoliSummary[]> {
    const [entries, state] = await Promise.all([readHolis(vault.root), stateOf(vault.remote)])
    return entries.map((e) => summarise(e, state[e.path]))
  }

  async function one(vault: HolisVault, path: string): Promise<HoliSummary> {
    const found = (await list(vault)).find((s) => s.path === path)
    if (found === undefined) throw new CapabilityError('NOT_FOUND', `${path} is gone`)
    return found
  }

  return {
    list,

    async approve(vault, ref, seen) {
      const entry = valid(find(await readHolis(vault.root), ref))
      const def = entry.parsed.def
      if (def.when !== undefined) {
        throw new CapabilityError(
          'BAD_REQUEST',
          `${def.name} is scheduled in the cloud, which no machine runs.`,
        )
      }
      if (seen !== fingerprint(def)) {
        throw new CapabilityError(
          'BAD_REQUEST',
          `${def.name} changed since you looked. Read it again before approving it.`,
        )
      }
      await changeState(vault.remote, entry.path, (s) => ({ ...s, approved: seen }))
      changed(vault.remote)
      return one(vault, entry.path)
    },

    async send(vault, ref, doc) {
      const entry = valid(find(await readHolis(vault.root), ref))
      const def = entry.parsed.def
      const status = statusOf(entry, (await stateOf(vault.remote))[entry.path])
      if (status === 'cloud') {
        throw new CapabilityError('BAD_REQUEST', `${def.name} is scheduled, not sent work.`)
      }
      if (status !== 'approved') {
        throw new CapabilityError(
          'FORBIDDEN',
          status === 'changed'
            ? `${def.name} changed since you approved it. Approve it again to send it work.`
            : `${def.name} is not approved on this machine yet.`,
        )
      }
      if (!holiAccepts(def, doc.path)) {
        throw new CapabilityError('BAD_REQUEST', `${def.name} does not take ${doc.path}.`)
      }
      if (sending.has(entry.path)) {
        throw new CapabilityError('BAD_REQUEST', `${def.name} is starting already.`)
      }
      sending.add(entry.path)
      try {
        const base = doc.path.slice(doc.path.lastIndexOf('/') + 1).replace(/\.md$/, '')
        const res = await deps.sessions.start({
          name: `${def.name} · ${base}`,
          prompt: sendPrompt(doc.path),
          ...(def.model === undefined ? {} : { model: def.model }),
          allow: [...def.allow, REPORT_RULE],
          appendSystemPrompt: holiSystemPrompt(def, entry.path),
          ...(doc.cols === undefined ? {} : { cols: doc.cols }),
          ...(doc.rows === undefined ? {} : { rows: doc.rows }),
        })
        if (!res.ok) throw new CapabilityError('UNAVAILABLE', res.message)
        const run: HoliRun = { jobId: res.sessionId, at: now().toISOString(), path: doc.path }
        await changeState(vault.remote, entry.path, (s) => ({
          ...s,
          runs: [run, ...s.runs].slice(0, RUNS_KEPT),
        }))
        changed(vault.remote)
        return { sessionId: res.sessionId, terminalId: res.terminalId }
      } finally {
        sending.delete(entry.path)
      }
    },

    async report(vault, ref, text, needsYou) {
      const clean = text.trim().slice(0, REPORT_MAX)
      if (clean === '') throw new CapabilityError('BAD_REQUEST', 'Say what came of the run.')
      const entry = find(await readHolis(vault.root), ref)
      const run = (await stateOf(vault.remote))[entry.path]?.runs[0]
      if (run === undefined) {
        throw new CapabilityError('BAD_REQUEST', `${holiIdOf(entry.path)} has no run to report on.`)
      }
      const report: RunReport = { text: clean, at: now().toISOString(), needsYou }
      await changeState(vault.remote, entry.path, (s) => ({
        ...s,
        runs: s.runs.map((r) => (r.jobId === run.jobId ? { ...r, report } : r)),
      }))
      changed(vault.remote)
      if (needsYou) {
        const name = entry.parsed.ok ? entry.parsed.def.name : holiIdOf(entry.path)
        deps.needsYou?.({ remote: vault.remote, id: holiIdOf(entry.path), name, text: clean })
      }
      return { ...run, report }
    },

    async create(vault, draft) {
      const id = holiSlug(draft.name)
      if (id === '') {
        throw new CapabilityError('BAD_REQUEST', 'Give it a name with a letter or a digit in it.')
      }
      const path = `${HOLIS_DIR}/${id}.yaml`
      const text = serializeHoliFile(draft)
      const parsed = parseHoliFile(text, path)
      if (!parsed.ok) throw new CapabilityError('BAD_REQUEST', parsed.error)
      const abs = join(vault.root, path)
      if ((await lstat(abs).catch(() => null)) !== null) {
        throw new CapabilityError('BAD_REQUEST', `There is already a Holi called ${id}.`)
      }
      await mkdir(join(vault.root, HOLIS_DIR), { recursive: true })
      await writeFile(abs, text, { flag: 'wx' })
      changed(vault.remote)
      return one(vault, path)
    },
  }
}
