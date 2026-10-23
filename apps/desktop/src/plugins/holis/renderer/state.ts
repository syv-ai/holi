/**
 * The vault's Holis as the Agents view and a document's Agent menu show them
 * (docs/features/holis.md). Main reads the folders and this machine's
 * approvals and runs, and says `holis` whenever any of them changes; this side
 * asks for the list again.
 *
 * A run is the session a send started, so what it is doing is that session's
 * state, read from the agent (`agentSessionRowsAtom`): working, or waiting on
 * the person. A run whose report asked for the person (`--needs-you`) needs
 * them too, until they have opened the Holi's page since.
 */
import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import {
  activeRemoteAtom,
  agentSessionRowsAtom,
  agentsSelectionAtom,
  appModeAtom,
  showAgentSessionAtom,
  type AgentSessionRow,
  type AgentsSessionItem,
  type ArcadeCastMember,
  type AgentsStatus,
  type PluginEventHandler,
  type PluginStore,
} from '@/plugin-api'
import { globToRegExp, HOLI_COLOURS, type HoliDraft } from '@holi/shared'
import { habitsCap, type HabitDraft } from './habits-cap'
import { holiCap, type HoliEdits, type HoliRun, type HoliSummary } from './holis-cap'

export type { HoliRun, HoliSummary }

export { holiCap }

/** The plugin's id: the owner of its rows in the Agents view. */
export const HOLIS_OWNER = 'holis'

export const holisAtom = atom<HoliSummary[]>([])
export const holisLoadedAtom = atom<'loading' | 'ready' | 'error'>('loading')
/** Bumped on every `holis` event: a Holi's page reads its soul and memory
 *  again. */
export const holisEpochAtom = atom(0)

/** When the person last had each Holi's page open, ISO, by Holi id: a
 *  report that asked for them before then has been seen. This machine's. */
export const holiSeenAtom = atomWithStorage<Record<string, string>>('holi.agents.seen', {})

export type HoliState = 'needs-you' | 'working' | 'idle'

/** A run's own state: its session's while it is live, else done. */
export type RunState = 'needs-you' | 'working' | 'done'

export function runState(run: HoliRun, sessions: readonly AgentSessionRow[]): RunState {
  const s = sessions.find((x) => x.id === run.jobId)
  if (s?.state === 'needs-you') return 'needs-you'
  if (s?.state === 'working') return 'working'
  return 'done'
}

/** Whether a run's report asked for the person and they have not seen it. */
export function reportNeedsYou(run: HoliRun, seen: string | undefined): boolean {
  const report = run.report
  return report?.needsYou === true && (seen === undefined || report.at > seen)
}

/** Whether a run asks for the person: waiting on them, or a report that
 *  asked and that they have not seen. */
export function runNeedsYou(
  run: HoliRun,
  sessions: readonly AgentSessionRow[],
  seen: string | undefined,
): boolean {
  return runState(run, sessions) === 'needs-you' || reportNeedsYou(run, seen)
}

/** What each Holi is doing, by id. */
export const holiStateAtom = atom((get) => {
  const sessions = get(agentSessionRowsAtom)
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

/** The reports that asked for the person and wait for them: the Inbox's
 *  rows. A session waiting on a prompt is the agent's own row there. */
export const holiAsksAtom = atom((get) => {
  const seen = get(holiSeenAtom)
  return get(holisAtom).flatMap((h) =>
    h.runs
      .slice(0, 5)
      .flatMap((run) => (reportNeedsYou(run, seen[h.id]) ? [{ holi: h, run }] : [])),
  )
})

/** What the mode toggle adds for Holis: the reports waiting on the person.
 *  Their sessions' states are the agent's to count. */
export const holisStatusAtom = atom((get): AgentsStatus => ({
  needsYou: get(holiAsksAtom).length,
  working: 0,
}))

/** How many of each Holi's runs the session list shows, newest first. */
const LISTED_RUNS = 10

/** A document's name without its folder or `.md`: what a run is about. */
const docName = (path: string): string => (path.split('/').pop() ?? path).replace(/\.md$/i, '')

/**
 * Each Holi's recent runs as rows of the agent's session list (the slot's
 * `sessions`), wearing the Holi's face. A run is its session (`jobId`): the
 * agent puts the live session's state on it, and opening it opens that
 * session. A run whose report asked for the person and that they have not
 * seen needs them, like the Inbox says.
 */
export const holiSessionItemsAtom = atom((get): AgentsSessionItem[] => {
  const seen = get(holiSeenAtom)
  return get(holisAtom).flatMap((h) =>
    h.runs.slice(0, LISTED_RUNS).map((run): AgentsSessionItem => {
      const ended = run.report === undefined ? undefined : Date.parse(run.report.at)
      const asks = reportNeedsYou(run, seen[h.id])
      return {
        key: `${HOLIS_OWNER}:${run.jobId}`,
        jobId: run.jobId,
        title: docName(run.path),
        state: asks ? 'needs-you' : 'idle',
        ...(asks ? { waitingFor: 'Its report asks for you' } : {}),
        updatedAt: ended ?? Date.parse(run.at),
        ...(ended === undefined ? {} : { endedAt: ended }),
        location: run.path,
        by: {
          kind: 'holi',
          name: h.name,
          mascot: h.mascot ?? 'strategist',
          color: h.color ?? HOLI_COLOURS[0],
        },
      }
    }),
  )
})

export const holiSessionsStatusAtom = atom((get) => get(holisLoadedAtom))

/** The vault's Holis as the empty view's arcade draws them: every one that
 *  parses, by its persona and colour. */
export const holisArcadeCastAtom = atom((get): readonly ArcadeCastMember[] =>
  get(holisAtom)
    .filter((h) => h.status !== 'invalid')
    .map((h) => ({
      id: h.id,
      name: h.name,
      mascot: h.mascot ?? 'strategist',
      color: h.color ?? HOLI_COLOURS[0],
    })),
)

/** The Holi a page shows, by id; the selection is core's. */
export const selectedHoliAtom = atom((get) => {
  const sel = get(agentsSelectionAtom)
  return sel?.owner === HOLIS_OWNER ? sel.id : null
})

/** Show a Holi's page in the Agents view. */
export const openHoliAtom = atom(null, (_get, set, id: string) => {
  set(appModeAtom, 'agents')
  set(agentsSelectionAtom, { owner: HOLIS_OWNER, id })
})

/** The Holis a document can be sent to, those that take it first. */
export function sendableFor(
  holis: readonly HoliSummary[],
  path: string,
): { takes: HoliSummary[]; rest: HoliSummary[] } {
  const takes: HoliSummary[] = []
  const rest: HoliSummary[] = []
  for (const h of holis) {
    if (h.status === 'invalid') continue
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
  // A Holi's files, approval or runs moved: ask for the list again.
  holis: ({ remote }, store) => {
    if (remote !== store.get(activeRemoteAtom)) return
    store.set(holisEpochAtom, (n) => n + 1)
    void reload(remote, store).catch(() => {})
  },
  // A notification was clicked: Agents mode, on that Holi.
  'holi-open': ({ remote, payload }, store) => {
    if (remote !== store.get(activeRemoteAtom)) return
    const p = payload as { holi?: unknown }
    if (typeof p?.holi !== 'string') return
    store.set(openHoliAtom, p.holi)
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

export type Result = { ok: true } | { ok: false; message: string }

const noVault = { ok: false as const, message: 'No vault is open.' }

export const failed = (err: unknown): { ok: false; message: string } => ({
  ok: false,
  message: err instanceof Error ? err.message : String(err),
})

/** An approval waiting on the person: the dialog shows exactly what it
 *  approves, and confirming approves it and, with a `path`, sends. */
export const pendingApprovalAtom = atom<{ holi: HoliSummary; path?: string } | null>(null)

/** Send the document to a Holi: a session on it, shown in the Agents view.
 *  One that is new or changed here asks for approval first. */
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
      const res = await holiCap.send(remote, { holi: args.holi.id, path: args.path })
      return await set(showAgentSessionAtom, { session: res.sessionId, live: true })
    } catch (err) {
      return failed(err)
    }
  },
)

/** Approve what the dialog showed, on this machine, then send if it was a
 *  send that asked. */
export const approvePendingAtom = atom(null, async (get, set): Promise<Result> => {
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
    if (pending.path === undefined) return { ok: true }
    return await set(sendToHoliAtom, { holi: approved, path: pending.path })
  } catch (err) {
    return failed(err)
  }
})

/**
 * The new-Holi wizard (docs/features/holis.md, The wizard): `create` walks
 * from what a Holi is to making one, starting from `draft` (a document's
 * folder as what it takes); `learn` is only the steps that explain.
 */
export interface HoliWizard {
  mode: 'create' | 'learn'
  draft?: Partial<HoliDraft>
  /** Start at making it: the person has just read how a Holi works. */
  skipIntro?: boolean
}
export const holiWizardAtom = atom<HoliWizard | null>(null)

/**
 * Make a Holi from the wizard, after MonoCode's `onCreateMono`: its folder
 * through `holis.create` (main's validation is the last word), then its first
 * habit, if one was asked for, through the automations' own `schedules.save`,
 * written off. Then its page, and the approval as for any new Holi: nothing
 * runs until this machine approved what it says.
 */
export const createHoliAtom = atom(
  null,
  async (
    get,
    set,
    args: { draft: Partial<HoliDraft>; habit?: Omit<HabitDraft, 'holi'> },
  ): Promise<{ ok: true; warning?: string } | { ok: false; message: string }> => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return noVault
    let made: HoliSummary
    try {
      made = await holiCap.create(remote, args.draft)
    } catch (err) {
      return failed(err)
    }
    set(holisAtom, (list) => [...list.filter((h) => h.id !== made.id), made])
    set(openHoliAtom, made.id)
    let habitError: string | null = null
    if (args.habit !== undefined) {
      try {
        await habitsCap.save(remote, { draft: { ...args.habit, holi: made.id } })
      } catch (err) {
        habitError = failed(err).message
      }
    }
    set(holiWizardAtom, null)
    if (made.status !== 'approved' && made.fingerprint !== undefined) {
      set(pendingApprovalAtom, { holi: made })
    }
    return habitError === null
      ? { ok: true }
      : { ok: true, warning: `${made.name} is made, but its habit is not: ${habitError}` }
  },
)

/** Change a Holi's settings, in its `holi.yaml`, in place. */
export const updateHoliAtom = atom(
  null,
  async (get, _set, args: { holi: string; edits: HoliEdits }): Promise<Result> => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return noVault
    try {
      await holiCap.update(remote, args)
      return { ok: true }
    } catch (err) {
      return failed(err)
    }
  },
)

/** The settings dialog, open on a Holi and a section. */
export type SettingsSection = 'general' | 'soul' | 'memory'
export const holiSettingsAtom = atom<{ id: string; section: SettingsSection } | null>(null)
