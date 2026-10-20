/**
 * The vault's Holis as the Agents view and a document's Agent menu show them
 * (docs/features/holis.md). Main reads the files and this machine's approvals
 * and runs, and says `holis` whenever any of them changes; this side asks for
 * the list again.
 *
 * A run is the session a send started, so what it is doing is that session's
 * state: working, or waiting on the person. A run whose report asked for the
 * person (`--needs-you`) needs them too, until they have opened the Holi's
 * page since.
 */
import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import {
  activeRemoteAtom,
  appModeAtom,
  type PluginEventHandler,
  type PluginStore,
} from '@/plugin-api'
import { globToRegExp, type HoliDraft } from '@holi/shared'
import { holiCap, type HoliRun, type HoliSummary } from '../agents-cap'
import { agentsViewAtom } from './agents-view'
import { landTerminalAtom } from './send'
import { agentGeometryAtom, agentSessionsAtom, type AgentSession } from './sessions'

export type { HoliRun, HoliSummary }

export { holiCap }

export const holisAtom = atom<HoliSummary[]>([])
export const holisLoadedAtom = atom<'loading' | 'ready' | 'error'>('loading')

/** When the person last had each Holi's page open, ISO, by Holi id: a
 *  report that asked for them before then has been seen. This machine's. */
export const holiSeenAtom = atomWithStorage<Record<string, string>>('holi.agents.seen', {})

export type HoliState = 'needs-you' | 'working' | 'idle'

/** A run's own state: its session's while it is live, else done. */
export type RunState = 'needs-you' | 'working' | 'done'

export function runState(run: HoliRun, sessions: readonly AgentSession[]): RunState {
  const s = sessions.find((x) => x.id === run.jobId)
  if (s?.state === 'needs-you') return 'needs-you'
  if (s?.state === 'working') return 'working'
  return 'done'
}

/** Whether a run asks for the person: waiting on them, or a report that
 *  asked and that they have not seen. */
export function runNeedsYou(
  run: HoliRun,
  sessions: readonly AgentSession[],
  seen: string | undefined,
): boolean {
  if (runState(run, sessions) === 'needs-you') return true
  const report = run.report
  return report?.needsYou === true && (seen === undefined || report.at > seen)
}

/** What each Holi is doing, by id. */
export const holiStateAtom = atom((get) => {
  const sessions = get(agentSessionsAtom)
  const seen = get(holiSeenAtom)
  const out: Record<string, HoliState> = {}
  for (const h of get(holisAtom)) {
    const recent = h.runs.slice(0, 5)
    out[h.id] = recent.some((r) => runNeedsYou(r, sessions, seen[h.id]))
      ? 'needs-you'
      : recent.some((r) => runState(r, sessions) === 'working')
        ? 'working'
        : 'idle'
  }
  return out
})

/** Job ids of the Holis' runs: those sessions are shown under their Holi,
 *  not again among the live sessions. */
export const holiJobIdsAtom = atom(
  (get) => new Set(get(holisAtom).flatMap((h) => h.runs.map((r) => r.jobId))),
)

/** The Holis a document can be sent to, those that take it first. */
export function sendableFor(
  holis: readonly HoliSummary[],
  path: string,
): { takes: HoliSummary[]; rest: HoliSummary[] } {
  const takes: HoliSummary[] = []
  const rest: HoliSummary[] = []
  for (const h of holis) {
    if (h.kind !== 'triggered' || h.status === 'invalid') continue
    // The globs as main reads them: the shared grammar's.
    const accepts = h.accepts ?? []
    if (accepts.length === 0 || accepts.some((g) => globToRegExp(g).test(path))) takes.push(h)
    else rest.push(h)
  }
  return { takes, rest }
}

async function reload(remote: string, store: PluginStore): Promise<void> {
  const list = await holiCap.list(remote)
  if (remote !== store.get(activeRemoteAtom)) return
  store.set(holisAtom, list)
  store.set(holisLoadedAtom, 'ready')
}

export const holiEvents: Readonly<Record<string, PluginEventHandler>> = {
  // A Holi's file, approval or runs moved: ask for the list again.
  holis: ({ remote }, store) => {
    if (remote !== store.get(activeRemoteAtom)) return
    void reload(remote, store).catch(() => {})
  },
  // A notification was clicked: Agents mode, on that Holi.
  'holi-open': ({ remote, payload }, store) => {
    if (remote !== store.get(activeRemoteAtom)) return
    const p = payload as { holi?: unknown }
    if (typeof p?.holi !== 'string') return
    store.set(appModeAtom, 'agents')
    store.set(agentsViewAtom, { kind: 'holi', id: p.holi })
  },
}

/** Ask for the list; the events keep it in step after. */
export const loadHolisAtom = atom(null, async (get, set) => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  set(holisLoadedAtom, 'loading')
  try {
    set(holisAtom, await holiCap.list(remote))
    set(holisLoadedAtom, 'ready')
  } catch {
    set(holisLoadedAtom, 'error')
  }
})

/** Ask main for something as the vault opens: it may not have started this
 *  plugin yet, so a refusal is asked again a few times. Returns the undo. */
function askSoon<T>(ask: () => Promise<T>, then: (value: T) => void): () => void {
  let gone = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const attempt = (n: number): void => {
    void ask().then(
      (value) => {
        if (!gone) then(value)
      },
      () => {
        if (gone || n >= 5) return
        timer = setTimeout(() => attempt(n + 1), 400 * (n + 1))
      },
    )
  }
  attempt(0)
  return () => {
    gone = true
    if (timer !== null) clearTimeout(timer)
  }
}

export function holisVault(remote: string, store: PluginStore): () => void {
  const off = askSoon(
    () => holiCap.list(remote),
    (list) => {
      store.set(holisAtom, list)
      store.set(holisLoadedAtom, 'ready')
    },
  )
  // Still nothing after the tries: say so, with Retry.
  const giveUp = setTimeout(() => {
    if (store.get(holisLoadedAtom) === 'loading') store.set(holisLoadedAtom, 'error')
  }, 10_000)
  return () => {
    off()
    clearTimeout(giveUp)
    store.set(holisAtom, [])
    store.set(holisLoadedAtom, 'loading')
  }
}

type Result = { ok: true } | { ok: false; message: string }

const noVault = { ok: false as const, message: 'No vault is open.' }

const failed = (err: unknown): { ok: false; message: string } => ({
  ok: false,
  message: err instanceof Error ? err.message : String(err),
})

/** A send waiting on the person's approval of the Holi: the dialog shows
 *  exactly what it approves, and confirming sends. */
export const pendingApprovalAtom = atom<{ holi: HoliSummary; path: string } | null>(null)

/** Send the document to a Holi: an agent tab on the session it starts. One
 *  that is new or changed here asks for approval first. */
export const sendToHoliAtom = atom(
  null,
  async (get, set, args: { holi: HoliSummary; path: string }): Promise<Result> => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return noVault
    if (args.holi.status !== 'approved') {
      set(pendingApprovalAtom, args)
      return { ok: true }
    }
    try {
      const res = await holiCap.send(remote, {
        holi: args.holi.id,
        path: args.path,
        ...get(agentGeometryAtom),
      })
      set(appModeAtom, 'documents')
      set(landTerminalAtom, res.terminalId)
      return { ok: true }
    } catch (err) {
      return failed(err)
    }
  },
)

/** Approve what the dialog showed, on this machine, then send. */
export const approveAndSendAtom = atom(null, async (get, set): Promise<Result> => {
  const remote = get(activeRemoteAtom)
  const pending = get(pendingApprovalAtom)
  if (remote === null) return noVault
  if (pending === null || pending.holi.fingerprint === undefined) {
    return { ok: false, message: 'This Holi does not parse, so it cannot run.' }
  }
  try {
    const approved = await holiCap.approve(remote, {
      holi: pending.holi.id,
      fingerprint: pending.holi.fingerprint,
    })
    set(pendingApprovalAtom, null)
    return await set(sendToHoliAtom, { holi: approved, path: pending.path })
  } catch (err) {
    return failed(err)
  }
})

/** The New Holi dialog, open, with what it starts from (a document's folder
 *  for its `accepts`). */
export const newHoliAtom = atom<{ accepts?: string } | null>(null)

export const createHoliAtom = atom(null, async (get, set, draft: HoliDraft): Promise<Result> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return noVault
  try {
    const made = await holiCap.create(remote, draft)
    set(agentsViewAtom, { kind: 'holi', id: made.id })
    set(appModeAtom, 'agents')
    return { ok: true }
  } catch (err) {
    return failed(err)
  }
})
