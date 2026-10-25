/**
 * The vault's assistant sessions, as the provider runs them.
 *
 * **A session is the provider's background session.** Its supervisor runs
 * it, its short job id names it, and it outlives any window onto it. Holi
 * does not spawn conversations; it asks the provider to (`cli.startBg`),
 * opens terminals onto them (`terminals.ts`), and reads what they are doing
 * (the provider's listing). This module ties those to the vault it is
 * attached to (`ensure`), which is the open one.
 *
 * Three things belong to the **vault**, not to any session, and live here: the
 * config directory, the sync pause (owned by
 * the turn coordinator), and the focus file the per-turn hook reads.
 *
 * **Holi does not decide what a session is doing.** The listing says so; the
 * hook bracket stays as the floor under it, because a slow or missing CLI
 * must still report a live turn, and the sync pause has a deadline a watcher
 * cannot meet.
 *
 * The session list is told to the renderer as the agent's `sessions` event,
 * whenever it changes.
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import type { PluginCtx } from '../../../../main/plugin-api'
import type { VaultCliTarget } from '../claude/cli'
import type { ClaudeRow, SessionSummary } from '../claude/listing'
import type { BackgroundProvider, VaultRef } from '../provider'
import type { AgentTerminals } from './terminals'
import { ContextSnapshot, type FocusInput } from './context-snapshot'
import { createTurnCoordinator, type TurnCoordinator, type TurnVault } from './turn-coordinator'
import type { TurnLog } from './turn-log'

/** How long after an `idle` reading to take the second one that confirms it.
 *  A quiet session produces no watcher edge, so nothing else would. */
const IDLE_RECHECK_MS = 1_100
/** The cap on stopping sessions as Holi leaves a vault: a hung CLI must not
 *  hold a vault switch or a quit. */
const LEAVE_CAP_MS = 5_000

export type ActionResult = { ok: true } | { ok: false; message: string }
export type OpenResult = { ok: true; terminalId: string } | { ok: false; message: string }
export type StartResult =
  { ok: true; sessionId: string; terminalId: string } | { ok: false; message: string }

export interface Geometry {
  cols?: number
  rows?: number
}

export type { VaultRef }

/** The vault the sessions run in, as its activation hands it over. */
export type AgentVault = Pick<PluginCtx, 'remote' | 'root'> & TurnVault

export interface AgentSessionsDeps {
  /** Tell the renderer `name` about the vault `remote`. */
  emit(remote: string, name: string, payload: unknown): void
  /** Tell the plugins built on the agent, in main: the session list as it is
   *  pushed (`sessions`) and each turn's end (`turn-end`). */
  publish?(name: string, payload: unknown): void
  /** The provider whose supervisor runs these sessions. */
  provider: Pick<
    BackgroundProvider,
    'id' | 'notInstalled' | 'configure' | 'terminal' | 'firstSpawn' | 'capabilities'
  >
  terminals: AgentTerminals
  /** Holi's generated commands, first on every session's `PATH`. */
  binDir(): string | null
  turnLogFor?: (vaultRoot: string) => TurnLog
  turnSafetyMs?: number
  idleRecheckMs?: number
  /** Forwarded to the turn coordinator. */
  idleConfirmMs?: number
  leaveCapMs?: number
  log?: (msg: string) => void
}

export interface AgentSessions {
  /** Attach to the open vault's sessions; until the next `leave`, every verb
   *  acts in this vault. Without one, finish attaching to the vault already
   *  given. Cheap when already attached. */
  ensure(vault?: AgentVault): Promise<void>
  /** The vault's live sessions, in listing order. */
  sessions(): SessionSummary[]
  /** Re-read the listing now. Never rejects. */
  refresh(): Promise<void>
  /** A terminal on the list (no `attach`), on one session, on a copy of a
   *  conversation by Claude Code's session id (`fork`), or running Claude
   *  Code's `/login` for the vault's config directory (`login`). */
  open(args: Geometry & { attach?: string; fork?: string; login?: boolean }): Promise<OpenResult>
  /** A new background session, and a terminal on it. With a prompt, that
   *  prompt is its first turn (reconcile); without, it waits for one. */
  start(
    args: Geometry & {
      name?: string
      prompt?: string
      /** A Holi's: its model, its rules and who it is (`holis/holis.ts`). */
      model?: string
      allow?: readonly string[]
      appendSystemPrompt?: string
    },
  ): Promise<StartResult>
  /** A new background session whose first turn is `prompt`, and no
   *  terminal: nobody is watching it start. A scheduled run. */
  launch(args: {
    name: string
    prompt: string
    model?: string
    allow?: readonly string[]
    /** A Holi's soul and memory, when one carries the run out. */
    appendSystemPrompt?: string
  }): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }>
  /** Whether Holi has a terminal open on the session. */
  watched(id: string): boolean
  /** Hear each session's turn end, by job id, with how much its Stop said
   *  was still pending (null when no Stop said: a confirmed idle, the safety
   *  cap, an older hook script). Returns the undo. */
  onTurnEnd(listener: (id: string, pending: number | null) => void): () => void
  /** Put text in a session's input, unsent: a live one by id, or a new one
   *  named from the text. Opens a terminal on it when Holi has none. */
  send(args: Geometry & { text: string; target: string | 'new' }): Promise<OpenResult>
  stop(id: string): Promise<ActionResult>
  respawn(id: string): Promise<ActionResult>
  duplicate(id: string, geometry?: Geometry): Promise<StartResult>
  /** A turn edge from the seeded hook, by vault and job id. */
  noteTurn(remote: string, jobId: string, active: boolean, pending?: number | null): void
  /** A session's status line fired: Claude Code's status JSON, by vault and
   *  job id. */
  noteStatus(remote: string, jobId: string, status: unknown): void
  /** The focus file is the vault's, so this names no session. */
  setFocus(focus: FocusInput): void
  /**
   * A turn edge from a driver outside the listing (the sessions Holi runs
   * itself, `pty-sessions.ts`), which knows its turns without the listing: the same working set, sync pause and turn record as a
   * session's. `forget` is its process gone mid-turn: nothing recorded. The
   * listing never names such an id, so its reconcile leaves these alone.
   */
  bracket(id: string, edge: 'begin' | 'end' | 'forget'): void
  /** Let go of the vault: optionally stop its live sessions, close every
   *  terminal, stop watching its config directory. Bounded; never rejects. */
  leave(opts?: { stopSessions?: boolean }): Promise<void>
}

interface Current {
  remote: string
  root: string
  vault: AgentVault
  configDir: string
  /** Set once this run's first terminal has asked about the sign-in marker:
   *  the marker is the directory's, so no later terminal needs to. */
  spawnChecked: boolean
  unwatch: () => void
  /** False until the first listing read, which seeds the working set. */
  seeded: boolean
}

export function createAgentSessions(deps: AgentSessionsDeps): AgentSessions {
  const log = deps.log ?? ((msg: string) => console.log(`[agent] ${msg}`))
  const provider = deps.provider
  const bg = provider.capabilities.background
  const statusReader = provider.capabilities.status
  let current: Current | null = null
  /** The vault `ensure` attached to, until `leave`. */
  let attached: AgentVault | null = null
  let activating: Promise<Current | null> | null = null
  /** Set while `leave` runs: nothing may attach to a vault on its way out,
   *  which would watch a directory Holi is letting go of. */
  let leaving: Promise<void> | null = null
  /** The latest listing for the current vault, live or not. */
  let rows: ClaudeRow[] = []
  let lastPushed = ''
  let idleRecheck: ReturnType<typeof setTimeout> | null = null
  let focusWriter: { root: string; snapshot: ContextSnapshot } | null = null
  /**
   * Sessions Holi started with no prompt that have not had a turn yet. Left
   * as they are, each one sits in Claude Code's list after Holi stops it, a
   * nameless row that resumes blank; so leaving the vault removes them.
   *
   * Holi's own record, not a reading of the listing, which cannot say whether
   * a session ever had a turn. A session resumed from the list is never on
   * it, so a conversation that exists is never removed.
   */
  const unprompted = new Set<string>()
  /** Turns an outside driver opened (`bracket`): its own ids, which the
   *  listing will never read live, so the reconcile must not forget them. */
  const bracketed = new Set<string>()
  /**
   * Each live session's context use, by job id, from its status line. Claude
   * Code's listing does not carry it. The status line runs on Claude Code's
   * own events, a background session with no client attached included, and a
   * session between turns is not using any more.
   */
  const contextPercent = new Map<string, number>()
  /** Each live session's model, in Claude Code's words, from its status line. */
  const modelName = new Map<string, string>()

  const turnEnds = new Set<(id: string, pending: number | null) => void>()
  /** What the Stop that is ending a turn said was pending, until the end is
   *  told. */
  const stopPending = new Map<string, number>()

  const coordinator: TurnCoordinator = createTurnCoordinator({
    vault: () => current?.vault ?? null,
    ...(deps.turnLogFor === undefined ? {} : { turnLogFor: deps.turnLogFor }),
    ...(deps.turnSafetyMs === undefined ? {} : { turnSafetyMs: deps.turnSafetyMs }),
    ...(deps.idleConfirmMs === undefined ? {} : { idleConfirmMs: deps.idleConfirmMs }),
    onChange: () => push(),
    onTurnEnd: (id) => {
      const pending = stopPending.get(id) ?? null
      stopPending.delete(id)
      for (const listener of turnEnds) listener(id, pending)
      deps.publish?.('turn-end', { id, pending })
    },
    log,
  })

  const live = (): ClaudeRow[] => rows.filter((row) => bg.isLive(row))
  const summaries = (): SessionSummary[] =>
    live().map((row) => {
      const percent = contextPercent.get(row.id)
      const model = modelName.get(row.id)
      return {
        provider: provider.id,
        ...bg.summarise(row, coordinator.working, {
          ...(percent === undefined ? {} : { contextPercent: percent }),
          ...(model === undefined ? {} : { model }),
        }),
      }
    })

  /** Tell the renderer the list, when it changed: the vault's, or `remote`'s
   *  as Holi lets go of it. */
  function push(remote = current?.remote): void {
    if (remote === undefined) return
    const next = summaries()
    const encoded = JSON.stringify(next)
    if (encoded === lastPushed) return
    lastPushed = encoded
    deps.emit(remote, 'sessions', next)
    if (remote === current?.remote) deps.publish?.('sessions', next)
  }

  const targetOf = (c: Current): VaultCliTarget => ({
    root: c.root,
    configDir: c.configDir,
    binDir: deps.binDir(),
  })

  async function activate(vault: AgentVault): Promise<Current | null> {
    const config = await provider
      .configure({ remote: vault.remote, root: vault.root })
      .catch((err: unknown) => {
        log(`config directory unresolved: ${String(err)}`)
        return null
      })
    if (config === null) return null
    const next: Current = {
      remote: vault.remote,
      root: vault.root,
      vault,
      configDir: config.dir,
      spawnChecked: false,
      unwatch: () => {},
      seeded: false,
    }
    next.unwatch = bg.watch(config.dir, () => void refresh(), log)
    return next
  }

  async function ensureCurrent(): Promise<Current | null> {
    if (leaving !== null) return null
    const vault = attached
    if (vault === null) return null
    if (current?.remote === vault.remote) return current
    if (activating !== null) return activating
    // A different vault without a `leave` in between: let go of the old one's
    // watch, but its sessions are not ours to stop from here.
    // Inside the one `activating` promise, so a second caller during the
    // release waits on it rather than activating the vault twice.
    const previous = current
    activating = (async () => {
      if (previous !== null) await release(previous)
      return activate(vault)
    })()
    try {
      current = await activating
    } finally {
      activating = null
    }
    if (current !== null) await refresh()
    return current
  }

  /** Serialised: a read that lands after a newer one must not win. */
  let reading: Promise<void> | null = null
  let readAgain = false

  async function readOnce(): Promise<void> {
    const c = current
    if (c === null) return
    const stdout = await bg.cli.list(targetOf(c))
    if (current !== c) return // the vault moved while we read
    rows = bg.parseListing(stdout, c.root)
    const liveRows = live()
    const liveIds = new Set(liveRows.map((r) => r.id))

    // Sessions keep running while Holi is closed, so the first read after
    // opening a vault may find one mid-turn: that turn holds sync too.
    if (!c.seeded) {
      c.seeded = true
      for (const row of liveRows) {
        if (row.status === 'busy' || row.status === 'shell') coordinator.begin(row.id)
      }
    }

    // A session whose process has gone will not end its turn now. Only the
    // listing's own: a bracketed turn is its driver's to end.
    for (const id of coordinator.working) {
      if (!bracketed.has(id) && !liveIds.has(id)) coordinator.forget(id)
    }
    // Nor use any more context; resumed, it says so again at its first event.
    for (const id of contextPercent.keys()) if (!liveIds.has(id)) contextPercent.delete(id)
    for (const id of modelName.keys()) if (!liveIds.has(id)) modelName.delete(id)

    let wantsRecheck = false
    for (const row of liveRows) {
      // Busy, or waiting on an answer, means a turn: the hook's floor.
      if (row.status !== undefined && row.status !== 'idle') unprompted.delete(row.id)
      if (row.status !== 'idle') {
        // Whatever it is doing, it is not between turns. That cancels any idle
        // candidacy, which makes the confirmation two CONSECUTIVE readings.
        coordinator.noteBusy(row.id)
        continue
      }
      if (!coordinator.working.has(row.id)) continue
      coordinator.noteIdle(row.id)
      if (coordinator.working.has(row.id)) wantsRecheck = true
    }
    if (wantsRecheck && idleRecheck === null) {
      idleRecheck = setTimeout(() => {
        idleRecheck = null
        void refresh()
      }, deps.idleRecheckMs ?? IDLE_RECHECK_MS)
    }
    push()
  }

  async function refresh(): Promise<void> {
    if (reading !== null) {
      readAgain = true
      return reading
    }
    reading = (async () => {
      do {
        readAgain = false
        await readOnce().catch((err: unknown) => log(`refresh failed: ${String(err)}`))
      } while (readAgain)
    })()
    try {
      await reading
    } finally {
      reading = null
    }
  }

  async function release(c: Current): Promise<void> {
    c.unwatch()
  }

  async function openOn(
    c: Current,
    args: Geometry & { attach?: string; fork?: string; login?: boolean },
  ): Promise<OpenResult> {
    // Taken here, at a terminal, not at vault open: a run that opens no
    // terminal must leave the notice for the one that does.
    let firstSpawn = false
    if (!c.spawnChecked) {
      c.spawnChecked = true
      firstSpawn = (await provider.firstSpawn?.take(c.configDir).catch(() => false)) ?? false
    }
    const notice = firstSpawn ? provider.firstSpawn?.notice : undefined
    const target = targetOf(c)
    const res = deps.terminals.open({
      remote: c.remote,
      cwd: target.root,
      command: provider.terminal(target, {
        ...(args.attach === undefined ? {} : { attach: args.attach }),
        ...(args.fork === undefined ? {} : { fork: args.fork }),
        ...(args.login === true ? { login: true } : {}),
      }),
      notInstalled: provider.notInstalled,
      ...(args.attach === undefined ? {} : { attach: args.attach }),
      ...(args.cols === undefined ? {} : { cols: args.cols }),
      ...(args.rows === undefined ? {} : { rows: args.rows }),
      ...(notice === undefined ? {} : { notice }),
    })
    return res.ok ? { ok: true, terminalId: res.id } : res
  }

  const noVault = { ok: false as const, message: 'No vault is open.' }

  const api: AgentSessions = {
    async ensure(vault) {
      if (vault !== undefined) attached = vault
      await ensureCurrent()
    },

    sessions: summaries,
    refresh,

    async open(args) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      return openOn(c, args)
    },

    async start({ name, prompt, model, allow, appendSystemPrompt, cols, rows: r }) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      const res = await bg.cli.startBg(targetOf(c), {
        ...(name === undefined ? {} : { name }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(model === undefined ? {} : { model }),
        ...(allow === undefined ? {} : { allow }),
        ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
      })
      if (!res.ok) return res
      if (prompt === undefined) unprompted.add(res.id)
      await refresh()
      const opened = await openOn(c, { attach: res.id, cols, rows: r })
      return opened.ok ? { ok: true, sessionId: res.id, terminalId: opened.terminalId } : opened
    },

    async launch({ name, prompt, model, allow, appendSystemPrompt }) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      const res = await bg.cli.startBg(targetOf(c), {
        name,
        prompt,
        ...(model === undefined ? {} : { model }),
        ...(allow === undefined ? {} : { allow }),
        ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
      })
      if (!res.ok) return res
      await refresh()
      return { ok: true, sessionId: res.id }
    },

    watched: (id) => deps.terminals.launchedFor(id) !== null,

    onTurnEnd(listener) {
      turnEnds.add(listener)
      return () => turnEnds.delete(listener)
    },

    async send({ text, target, cols, rows: r }) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      let terminalId: string
      if (target === 'new') {
        // The CLI makes a name of the text's first line.
        const started = await api.start({ name: text, cols, rows: r })
        if (!started.ok) return started
        terminalId = started.terminalId
      } else {
        if (!live().some((row) => row.id === target)) {
          return { ok: false, message: 'That session has ended. Pick another one.' }
        }
        const existing = deps.terminals.launchedFor(target)
        if (existing !== null) terminalId = existing
        else {
          const opened = await openOn(c, { attach: target, cols, rows: r })
          if (!opened.ok) return opened
          terminalId = opened.terminalId
        }
      }
      deps.terminals.paste(terminalId, text)
      return { ok: true, terminalId }
    },

    async stop(id) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      const res = await bg.cli.stop(targetOf(c), id)
      await refresh()
      return res
    },

    async respawn(id) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      const res = await bg.cli.respawn(targetOf(c), id)
      await refresh()
      return res
    },

    async duplicate(id, geometry = {}) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      const row = rows.find((r) => r.id === id)
      if (row?.sessionId === undefined) {
        return { ok: false, message: 'Claude Code has not said which conversation this is yet.' }
      }
      const label = bg.summarise(row, coordinator.working).name
      const name = label === 'New session' ? undefined : `${label} (copy)`
      const res = await bg.cli.forkBg(targetOf(c), row.sessionId, name)
      if (!res.ok) return res
      await refresh()
      const opened = await openOn(c, { attach: res.id, ...geometry })
      return opened.ok ? { ok: true, sessionId: res.id, terminalId: opened.terminalId } : opened
    },

    noteTurn(remote, jobId, active, pending = null) {
      // A turn in a vault Holi is not showing is not this vault's pause.
      if (current?.remote !== remote) return
      if (active) unprompted.delete(jobId)
      if (active) coordinator.begin(jobId)
      else {
        if (pending !== null) stopPending.set(jobId, pending)
        coordinator.end(jobId)
        stopPending.delete(jobId)
      }
      void refresh()
    },

    noteStatus(remote, jobId, report) {
      // Only the vault Holi is showing has rows to put a number on.
      if (current?.remote !== remote) return
      const percent = statusReader?.contextPercent(report) ?? null
      if (percent === null) contextPercent.delete(jobId)
      else contextPercent.set(jobId, percent)
      const model = statusReader?.model(report) ?? null
      if (model !== null) modelName.set(jobId, model)
      push()
    },

    setFocus(focus) {
      const vault = attached
      if (vault === null) return
      if (focusWriter?.root !== vault.root) {
        focusWriter?.snapshot.stop()
        focusWriter = { root: vault.root, snapshot: new ContextSnapshot({ workRoot: vault.root }) }
      }
      focusWriter.snapshot.setFocus(focus)
    },

    bracket(id, edge) {
      if (edge === 'begin') {
        bracketed.add(id)
        coordinator.begin(id)
        return
      }
      bracketed.delete(id)
      if (edge === 'end') coordinator.end(id)
      else coordinator.forget(id)
    },

    async leave({ stopSessions = true } = {}) {
      if (leaving !== null) return leaving
      leaving = leaveNow(stopSessions)
      try {
        await leaving
      } finally {
        leaving = null
      }
    },
  }

  async function leaveNow(stopSessions: boolean): Promise<void> {
    // A vault still attaching is the one being left: let it land first.
    if (activating !== null) await activating
    attached = null
    const c = current
    if (c === null) return
    if (stopSessions) {
      // Stop, then remove the ones that never had a turn (`unprompted`).
      const stops = Promise.all(
        live().map(async (row) => {
          const stopped = await bg.cli.stop(targetOf(c), row.id)
          if (stopped.ok && unprompted.has(row.id)) await bg.cli.rm(targetOf(c), row.id)
        }),
      )
      await Promise.race([
        stops,
        new Promise((r) => setTimeout(r, deps.leaveCapMs ?? LEAVE_CAP_MS)),
      ])
    }
    await deps.terminals.closeAll()
    for (const id of [...coordinator.working]) coordinator.forget(id)
    bracketed.clear()
    unprompted.clear()
    contextPercent.clear()
    modelName.clear()
    if (idleRecheck !== null) {
      clearTimeout(idleRecheck)
      idleRecheck = null
    }
    focusWriter?.snapshot.stop()
    focusWriter = null
    current = null
    rows = []
    await release(c)
    push(c.remote)
  }
  return api
}
