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
import {
  CapabilityError,
  UnconfirmedOwnedProgramError,
  type PluginCtx,
} from '../../../../main/plugin-api'
import type { VaultCliTarget } from '../claude/cli'
import type { ClaudeRow, SessionSummary } from '../claude/listing'
import type { SessionChannel } from '../claude/messaging'
import { firstSpawnNotice, type BackgroundProvider } from '../provider'
import {
  createClaudeLaunchAdmission,
  unconfirmed,
  type CliCreation,
  type Failure,
  type Unconfirmed,
} from './claude-launch-admission'
import { ContextSnapshot, type FocusInput } from './context-snapshot'
import { createLateSessionCleanup } from './late-session-cleanup'
import { admitAgentSessions, createOwnedOperationTracker } from './session-admission'
import type { AgentTerminals, PresentationLease } from './terminals'
import { createTurnCoordinator, type TurnCoordinator, type TurnVault } from './turn-coordinator'
import type { TurnLog } from './turn-log'

/** How long after an `idle` reading to take the second one that confirms it.
 *  A quiet session produces no watcher edge, so nothing else would. */
const IDLE_RECHECK_MS = 1_100
/** The cap on stopping sessions as Holi leaves a vault: a hung CLI must not
 *  hold a vault switch or a quit. */
const LEAVE_CAP_MS = 5_000

export type ActionResult = { ok: true } | Failure | Unconfirmed
export type OpenResult = { ok: true; terminalId: string } | Failure | Unconfirmed
export type StartResult =
  { ok: true; sessionId: string; terminalId: string } | Failure | Unconfirmed
type LaunchResult = { ok: true; sessionId: string } | Failure | Unconfirmed

export interface Geometry {
  cols?: number
  rows?: number
}

/**
 * The vault the sessions run in, as its activation hands it over.
 * @public exported for its test
 */
export type AgentVault = Pick<PluginCtx, 'remote' | 'root'> & TurnVault

export interface AgentSessionsDeps {
  /** Tell the renderer `name` about the vault `remote`. */
  emit(remote: string, name: string, payload: unknown): void
  /** Tell the plugins built on the agent, in main: the session list as it is
   *  pushed (`sessions`) and each turn's end (`turn-end`). */
  publish?(name: string, payload: unknown): void
  /** Revokes PTY/session admission when this vault activation is invalidated. */
  activationSignal?: AbortSignal
  /** The provider whose supervisor runs these sessions. */
  provider: Pick<
    BackgroundProvider,
    'id' | 'notInstalled' | 'configure' | 'terminal' | 'firstSpawn' | 'capabilities'
  >
  terminals: AgentTerminals
  /** Holi's generated commands, first on every session's `PATH`. */
  binDir(): string | null
  turnLogFor?: (vaultRoot: string) => TurnLog
  /** See `TurnCoordinatorDeps.snapshot`. */
  snapshot?: (vaultRoot: string) => Promise<string | null>
  turnSafetyMs?: number
  idleRecheckMs?: number
  /** Forwarded to the turn coordinator. */
  idleConfirmMs?: number
  leaveCapMs?: number
  /** Whether a process is still running; `process.kill(pid, 0)` unless a
   *  test says otherwise. */
  alive?: (pid: number) => boolean
  log?: (msg: string) => void
}

/** Whether `pid` names a running process. EPERM means it runs as someone
 *  else, which is still running. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface AgentSessions {
  /** Attach to this activation's vault; the owner is fixed until `leave`.
   *  Without one, finish attaching to the vault already given. Cheap when already attached. */
  ensure(vault?: AgentVault): Promise<void>
  /** The vault's live sessions, in listing order. */
  sessions(): SessionSummary[]
  /** The ones the listing still has but whose process is gone: stopped, or
   *  retired by the supervisor. Opening one brings it back (`respawn`). */
  past(): SessionSummary[]
  /** Re-read while listing probes remain safe. Read failures leave the last
   *  verified listing in place; teardown reports unconfirmed native cleanup. */
  refresh(): Promise<void>
  /** A terminal on the list (no `attach`), on one session, or on a copy of
   *  a conversation by Claude Code's session id (`fork`). Its sign-in is a
   *  session Holi runs (`pty-sessions.ts`). */
  open(
    args: Geometry & { attach?: string; fork?: string },
    lease: PresentationLease,
  ): Promise<OpenResult>
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
    lease: PresentationLease,
  ): Promise<StartResult>
  /** A new background session whose first turn is `prompt`, and no
   *  terminal: nobody is watching it start. A scheduled run. */
  launch(args: {
    name: string
    prompt: string
    model?: string
    allow?: readonly string[]
    /** Rules it may never use, whatever the vault allows. */
    deny?: readonly string[]
    /** A Holi's soul and memory, when one carries the run out. */
    appendSystemPrompt?: string
    /** An MCP JSON config the session loads besides the vault's own. */
    mcpConfig?: string
  }): Promise<LaunchResult>
  /** Whether Holi has a terminal open on the session. */
  watched(id: string): boolean
  /** Hear each session's turn end, by job id, with how much its Stop said
   *  was still pending (null when no Stop said: a confirmed idle, the safety
   *  cap, an older hook script). Returns the undo. */
  onTurnEnd(listener: (id: string, pending: number | null) => void): () => void
  /** Hear the live sessions each time the list told to the renderer
   *  changes. Returns the undo. */
  onSessions(listener: (sessions: SessionSummary[]) => void): () => void
  /** Put text in a session's input, unsent: a live one by id, or a new one
   *  named from the text. Opens a terminal on it when Holi has none. */
  send(
    args: Geometry & { text: string; target: string | 'new' },
    lease: PresentationLease,
  ): Promise<OpenResult>
  stop(id: string): Promise<ActionResult>
  respawn(id: string, lease: PresentationLease): Promise<ActionResult>
  duplicate(
    id: string,
    geometry: Geometry | undefined,
    lease: PresentationLease,
  ): Promise<StartResult>
  /** A turn edge from the seeded hook, by vault and job id. A start may say
   *  the session's process id, which outlives a listing that loses the id. At
   *  an end, answers the settle commit it took (`TurnCoordinator.end`), or null. */
  noteTurn(
    remote: string,
    jobId: string,
    active: boolean,
    pending?: number | null,
    pid?: number,
  ): Promise<string | null>
  /** A session's status line fired: Claude Code's status JSON, by vault and
   *  job id. */
  noteStatus(remote: string, jobId: string, status: unknown): void
  /** A session's hook said where it takes messages, by vault and job id. */
  noteChannel(remote: string, jobId: string, channel: SessionChannel): void
  /** Add `text` to a running session's conversation: a turn when it is idle,
   *  read after the tool call in flight when it is working. Never typed into
   *  a terminal. Throws a `CapabilityError` when it cannot be delivered. */
  message(id: string, text: string): Promise<void>
  /** The focus file is the vault's, so this names no session. */
  setFocus(focus: FocusInput): void
  /**
   * A turn edge from a driver outside the listing (the sessions Holi runs
   * itself, `pty-sessions.ts`), which knows its turns without the listing: the same working set, sync pause and turn record as a
   * session's. `forget` is its process gone mid-turn: nothing recorded. The
   * listing never names such an id, so its reconcile leaves these alone.
   */
  bracket(id: string, edge: 'begin' | 'end' | 'forget'): unknown | Promise<string | null>
  /** Let go of the vault: optionally stop its live sessions, close every
   *  terminal, stop watching its config directory. Reports unconfirmed drains. */
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

export function createAgentSessions(deps: AgentSessionsDeps): AgentSessions & {
  /** Reserve an open PTY turn until its own physical proof, not the listing. */
  protectPtyTurn(id: string): (() => void) | undefined
} {
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
  let drainFailure: AggregateError | null = null
  const activationSignal = deps.activationSignal
  let admissionClosed = activationSignal?.aborted ?? false
  const lifetime = new AbortController()
  // Always bind the grant to the original activation, including a direct leave
  // in callers that do not supply a plugin activation signal.
  const commitSignal = activationSignal
    ? AbortSignal.any([activationSignal, lifetime.signal])
    : lifetime.signal
  const lateCleanup = createLateSessionCleanup()
  let identifying = false
  let focusStop: Promise<void> | null = null
  let focusStopFailure: unknown | null = null
  function revoke(): void {
    if (admissionClosed) return
    admissionClosed = true
    lifetime.abort()
    if (idleRecheck !== null) {
      clearTimeout(idleRecheck)
      idleRecheck = null
    }
    if (focusWriter !== null && focusStop === null) {
      focusStop = focusWriter.snapshot.stop().catch((error: unknown) => {
        focusStopFailure = error
      })
    }
  }
  activationSignal?.addEventListener('abort', revoke, { once: true })
  /** This provider's verified rows and shutdown inventory for the attached vault. */
  const inventory = {
    rows: [] as ClaudeRow[],
    listed: new Set<string>(),
    // A missing or past row cannot prove that a pending owner drained.
    pending: new Set<string>(),
    uncertain: new Map<string, Unconfirmed>(),
    acting: new Set<string>(),
    unpublished: new Set<string>(),
    /**
     * Sessions Holi started with no prompt that have not had a turn yet. Left
     * as they are, each one sits in Claude Code's list after Holi stops it, a
     * nameless row that resumes blank; so leaving the vault removes them.
     *
     * Holi's own record, not a reading of the listing, which cannot say whether
     * a session ever had a turn. A session resumed from the list is never on
     * it, so a conversation that exists is never removed.
     */
    unprompted: new Set<string>(),
    revision: 0,
  }
  const admission = createClaudeLaunchAdmission(
    inventory,
    lateCleanup,
    deps.terminals,
    commitSignal,
  )
  let lastPushed = ''
  let lastPast = ''
  let idleRecheck: ReturnType<typeof setTimeout> | null = null
  let focusWriter: { root: string; snapshot: ContextSnapshot } | null = null
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
  /**
   * Where each session takes messages, by job id, as its hooks reported it.
   * In memory only: the token is the session's, and a file would outlive it.
   * Dropped when the session leaves the live listing, when a write to it
   * fails, and when Holi lets go of the vault. A session is told apart
   * from one not yet listed by `listedLive`: a `SessionStart` report can
   * arrive before the listing shows the session at all.
   */
  const channels = new Map<string, SessionChannel>()
  const earlyStatus = new Map<string, unknown>()
  const earlyChannels = new Map<string, SessionChannel>()
  let listedLive = new Set<string>()

  const turnEnds = new Set<(id: string, pending: number | null) => void>()
  const sessionListeners = new Set<(sessions: SessionSummary[]) => void>()
  /** What the Stop that is ending a turn said was pending, until the end is
   *  told. */
  const stopPending = new Map<string, number>()
  /**
   * Each working session's process, by job id: from its turn-start hook, or
   * from the listing while it named the session. A working session the
   * listing does not name is let go only once this process is gone, because
   * the listing can lose sight of a live one (a resumed conversation). One
   * with no known process (a hook older than the pid) is let go as soon as
   * the listing stops naming it. Pids are reused, but only after the counter
   * wraps; a turn held by a reused one still ends at the safety cap. Both
   * sources are kept and either running holds the turn: a listing read that
   * started before a resume finishes with the previous process's row, and a
   * process whose start report never arrived is known only to the listing.
   */
  const workingPid = new Map<string, { hook?: number; listing?: number }>()
  const alive = deps.alive ?? processAlive

  const coordinator: TurnCoordinator = createTurnCoordinator({
    vault: () => current?.vault ?? null,
    ...(deps.turnLogFor === undefined ? {} : { turnLogFor: deps.turnLogFor }),
    ...(deps.snapshot === undefined ? {} : { snapshot: deps.snapshot }),
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

  function applyStatus(jobId: string, report: unknown): void {
    const percent = statusReader?.contextPercent(report) ?? null
    if (percent === null) contextPercent.delete(jobId)
    else contextPercent.set(jobId, percent)
    const model = statusReader?.model(report) ?? null
    if (model !== null) modelName.set(jobId, model)
  }

  const live = (): ClaudeRow[] => inventory.rows.filter((row) => bg.isLive(row))
  const past = (): SessionSummary[] =>
    inventory.rows
      .filter((row) => !bg.isLive(row))
      .map((row) => ({ provider: provider.id, ...bg.summarise(row, new Set()) }))
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
    for (const listener of sessionListeners) listener(next)
  }

  /** Tell the renderer the stopped sessions, when they changed. */
  function pushPast(remote = current?.remote): void {
    if (remote === undefined) return
    const next = past()
    const encoded = JSON.stringify(next)
    if (encoded === lastPast) return
    lastPast = encoded
    deps.emit(remote, 'history', next)
  }

  const targetOf = (c: Current): VaultCliTarget => ({
    root: c.root,
    configDir: c.configDir,
    binDir: deps.binDir(),
  })

  /** Revalidate ownership after every await before admitting native work. */
  const admittedFor = (c: Current | null, owner: AgentVault | null): c is Current =>
    c !== null &&
    !admissionClosed &&
    !activationSignal?.aborted &&
    leaving === null &&
    attached === owner &&
    owner !== null &&
    current === c

  function trackPendingShutdown(id: string): void {
    inventory.revision++
    inventory.pending.add(id)
  }

  function confirmStopped(id: string): void {
    inventory.revision++
    inventory.pending.delete(id)
    inventory.listed.delete(id)
  }

  async function stopProvider(target: VaultCliTarget, id: string): Promise<void> {
    const result = await bg.cli.stop(target, id)
    if (!result.ok)
      throw result.error ?? new Error(`Could not stop session ${id}: ${result.message}`)
    confirmStopped(id)
  }

  const vaultClosed = { ok: false as const, message: 'The vault closed as the session started.' }

  /** Own discovery, admission and cleanup as one operation. Never substitute
   * a provider stop for a still-revocable native launch. */
  function createBackground(
    c: Current,
    target: VaultCliTarget,
    create: () => Promise<CliCreation>,
    terminal: Geometry & { lease: PresentationLease },
    blank?: boolean,
  ): Promise<StartResult>
  function createBackground(
    c: Current,
    target: VaultCliTarget,
    create: () => Promise<CliCreation>,
  ): Promise<LaunchResult>
  async function createBackground(
    c: Current,
    target: VaultCliTarget,
    create: () => Promise<CliCreation>,
    terminal?: Geometry & { lease: PresentationLease },
    blank = false,
  ): Promise<Failure | Unconfirmed | { ok: true; sessionId: string; terminalId?: string }> {
    const presented = () => terminal === undefined || terminal.lease()
    if (!presented()) return vaultClosed
    const alreadyBlocked = admission.creationBlock()
    if (alreadyBlocked) return alreadyBlocked
    const unlock = await admission.acquire()
    if (unlock === null) return vaultClosed
    let released = false
    const releaseAdmission = () => {
      if (released) return
      released = true
      // A read from the discovery window cannot overwrite verified history
      // when a rejected receipt never reserved an id.
      if (identifying) inventory.revision++
      identifying = false
      unlock()
    }
    try {
      if (!admittedFor(c, c.vault) || !presented()) return vaultClosed
      const blocked = admission.creationBlock()
      if (blocked) return blocked
      // The listing cannot identify an in-flight launch. Delay applying reads
      // until we can withhold its exact job id until native commit.
      identifying = true
      const result = await create()
      if (!result.ok) {
        if (!result.cleanupUnconfirmed) return result
        const failure = admission.retainFailedReceipt(result)
        if (!admittedFor(c, c.vault) || !presented())
          await admission.revokeUnconfirmed(failure.error)
        return failure
      }
      const { id, lease } = result
      const occupied = admission.rejectCollision(result)
      if (occupied !== undefined) return await occupied
      let tracked = false
      let committed = false
      let terminalId: string | undefined
      async function closeTerminal(): Promise<boolean> {
        if (terminalId === undefined) return true
        try {
          return await deps.terminals.discard(terminalId, terminal!.lease)
        } catch (error) {
          lateCleanup.recordFailure(error)
          if (error instanceof Error && !admittedFor(c, c.vault))
            await admission.revokeUnconfirmed(error)
          throw error
        }
      }
      const discard = async (
        failure: Failure,
        commandError = failure.error,
      ): Promise<Failure | Unconfirmed> => {
        if (!(await closeTerminal())) return failure
        inventory.unprompted.delete(id)
        try {
          if (lease !== undefined && !committed) {
            await lateCleanup.revoke(lease)
            if (tracked) {
              inventory.pending.delete(id)
              inventory.revision++
            }
          } else await lateCleanup.track(() => stopProvider(target, id))
        } catch (cause) {
          const unresolved = admission.retainFailure(
            unconfirmed(cause, id, committed ? undefined : lease, commandError),
            true,
          )
          if (!admittedFor(c, c.vault) || !presented())
            await admission.revokeUnconfirmed(unresolved.error)
          return unresolved
        }
        inventory.unpublished.delete(id)
        releaseAdmission()
        await refresh()
        return failure
      }
      if (!admittedFor(c, c.vault) || !presented()) return await discard(vaultClosed)
      const openFailure = (error: unknown): Failure => ({
        ok: false,
        message: error instanceof Error ? error.message : 'Could not open session.',
        ...(error instanceof Error ? { error } : {}),
      })
      let notice: string | undefined
      try {
        if (terminal !== undefined) notice = await prepareOpen(c)
      } catch (error) {
        const occupied = admission.rejectCollision(result)
        if (occupied !== undefined) return await occupied
        return await discard(openFailure(error))
      }
      // First-spawn preparation can yield to another session action or attach.
      // Recheck before reserving so we never count our own pending id.
      const refused = admission.rejectCollision(result)
      if (refused !== undefined) return await refused
      if (!admittedFor(c, c.vault) || !presented()) return await discard(vaultClosed)
      // Teardown owns the pending id, but listing cannot adopt it before commit.
      if (lease !== undefined) inventory.unpublished.add(id)
      trackPendingShutdown(id)
      tracked = true
      identifying = false
      if (blank) inventory.unprompted.add(id)
      if (lease !== undefined) {
        try {
          await lease.commit(commitSignal)
          committed = true
          // A read begun before commit cannot transfer the pending id.
          inventory.revision++
        } catch (cause) {
          if (commitSignal.aborted && cause === commitSignal.reason)
            return await discard(
              vaultClosed,
              cause instanceof Error ? cause : new Error(vaultClosed.message, { cause }),
            )
          // Commit has settled. Join the original lease, not a provider stop.
          let revoked: PromiseSettledResult<void>
          try {
            await lateCleanup.revoke(lease)
            revoked = { status: 'fulfilled', value: undefined }
          } catch (reason) {
            revoked = { status: 'rejected', reason }
          }
          return admission.rejectCommit(id, lease, cause, revoked)
        }
        if (!admittedFor(c, c.vault) || !presented()) return await discard(vaultClosed)
      }
      // Never attach a terminal to a retained run that has not actually committed.
      if (terminal !== undefined) {
        try {
          const opened = openPrepared(c, { ...terminal, attach: id }, terminal.lease, notice)
          if (!opened.ok) return await discard(opened)
          terminalId = opened.terminalId
        } catch (error) {
          return await discard(openFailure(error))
        }
      }
      inventory.unpublished.delete(id)
      // The next receipt can now check this id against the pending owner (or
      // the verified listing). Refresh is still this operation's to join.
      releaseAdmission()
      if (admittedFor(c, c.vault) && presented()) await refresh()
      if (!admittedFor(c, c.vault) || !presented()) return await discard(vaultClosed)
      return { ok: true, sessionId: id, ...(terminalId === undefined ? {} : { terminalId }) }
    } finally {
      releaseAdmission()
    }
  }

  async function changeSession(
    c: Current,
    id: string,
    action: 'stop' | 'respawn',
    presentation?: PresentationLease,
  ): Promise<ActionResult> {
    const presented = () => presentation === undefined || presentation()
    if (!presented()) return vaultClosed
    const failure = inventory.uncertain.get(id)
    if (failure) return failure
    // When no further listing can verify ownership, stop only known owners
    // and don't admit new processes.
    const blocked = admission.inventoryFailure()
    if (blocked) {
      // A collision fences new identities and listing adoption, not an
      // explicit resume of a conversation that was already verified.
      const known =
        action === 'respawn'
          ? admission.canResume(blocked, id)
          : inventory.listed.has(id) || inventory.pending.has(id)
      if (!known) return blocked
    }
    if (inventory.unpublished.has(id) || inventory.acting.has(id))
      return { ok: false, message: `Session ${id} is still changing.` }
    inventory.acting.add(id)
    const target = targetOf(c)
    try {
      const result = await bg.cli[action](target, id)
      if (!result.ok && result.cleanupUnconfirmed) {
        const failure = admission.retainFailure({ ...result, sessionId: id })
        if (!admittedFor(c, c.vault)) await admission.revokeUnconfirmed(failure.error)
        return failure
      }
      if (result.ok) {
        if (action === 'respawn') trackPendingShutdown(id)
        else confirmStopped(id)
      }
      if (admittedFor(c, c.vault) && presented()) await refresh()
      if (!result.ok || (admittedFor(c, c.vault) && presented())) return result
      if (action === 'respawn') {
        try {
          await lateCleanup.track(() => stopProvider(target, id))
        } catch (cause) {
          const failure = admission.retainFailure(unconfirmed(cause, id))
          await admission.revokeUnconfirmed(failure.error)
          return failure
        }
      }
      return { ok: false, message: `The vault was left before ${action} completed.` }
    } finally {
      inventory.acting.delete(id)
    }
  }

  async function activate(vault: AgentVault): Promise<Current | null> {
    const config = await provider
      .configure({ remote: vault.remote, root: vault.root })
      .catch((err: unknown) => {
        log(`config directory unresolved: ${String(err)}`)
        return null
      })
    if (config === null || admissionClosed || activationSignal?.aborted) return null
    const next: Current = {
      remote: vault.remote,
      root: vault.root,
      vault,
      configDir: config.dir,
      spawnChecked: false,
      unwatch: () => {},
      seeded: false,
    }
    next.unwatch = bg.watch(
      config.dir,
      () => {
        if (!admissionClosed) void refresh()
      },
      log,
    )
    for (const [id, report] of earlyStatus) applyStatus(id, report)
    earlyStatus.clear()
    for (const [id, channel] of earlyChannels) channels.set(id, channel)
    earlyChannels.clear()
    return next
  }

  async function ensureCurrent(): Promise<Current | null> {
    if (admissionClosed || activationSignal?.aborted || leaving !== null) return null
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
    const before = inventory.revision
    let stdout: string | null
    try {
      stdout = await bg.cli.list(targetOf(c))
    } catch (error) {
      if (error instanceof UnconfirmedOwnedProgramError) {
        // Retain on the activation that launched the probe, even if revoked
        // during the read. Join this exact command, not a session from stdout.
        admission.retainListingFailure(error)
        await admission.revokeUnconfirmed(error)
      }
      throw error
    }
    // A command confirmed while this read was in flight may not be in it.
    // Use the refresh queued by that command rather than overwrite its inventory.
    if (
      stdout === null ||
      !admittedFor(c, c.vault) ||
      identifying ||
      before !== inventory.revision ||
      admission.inventoryFailure()
    )
      return
    // Parsing is atomic and may throw on a malformed row. Don't change any
    // display, working state, or shutdown inventory until it succeeds.
    inventory.rows = bg
      .parseListing(stdout, c.root)
      .filter((row) => !inventory.unpublished.has(row.id))
    const liveRows = live()
    const liveIds = new Set(liveRows.map((r) => r.id))
    // Transfer a pending id only when it actually appears live. Even a
    // verified empty listing can lag a successful command.
    inventory.listed = new Set(liveIds)
    for (const id of liveIds) inventory.pending.delete(id)

    // Sessions keep running while Holi is closed, so the first read after
    // opening a vault may find one mid-turn: that turn holds sync too.
    if (!c.seeded) {
      c.seeded = true
      for (const row of liveRows) {
        if (row.status === 'busy' || row.status === 'shell') coordinator.begin(row.id)
      }
    }

    for (const row of liveRows) {
      if (row.pid === undefined || !coordinator.working.has(row.id)) continue
      workingPid.set(row.id, { ...workingPid.get(row.id), listing: row.pid })
    }
    // A session whose process has gone will not end its turn now. Only the
    // listing's own: a bracketed turn is its driver's to end. Its process,
    // when known, says whether it is gone, not the listing (`workingPid`).
    for (const id of coordinator.working) {
      if (bracketed.has(id) || liveIds.has(id)) continue
      const known = workingPid.get(id)
      const running = [known?.hook, known?.listing].some((p) => p !== undefined && alive(p))
      if (!running) coordinator.forget(id)
    }
    for (const id of workingPid.keys()) if (!coordinator.working.has(id)) workingPid.delete(id)
    // Nor use any more context; resumed, it says so again at its first event.
    for (const id of contextPercent.keys()) if (!liveIds.has(id)) contextPercent.delete(id)
    for (const id of modelName.keys()) if (!liveIds.has(id)) modelName.delete(id)
    // Nor take messages: a resumed process binds a new inbox and says so.
    for (const id of channels.keys())
      if (listedLive.has(id) && !liveIds.has(id)) channels.delete(id)
    listedLive = liveIds

    let wantsRecheck = false
    for (const row of liveRows) {
      // Busy, or waiting on an answer, means a turn: the hook's floor.
      if (row.status !== undefined && row.status !== 'idle') inventory.unprompted.delete(row.id)
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
    pushPast()
  }

  async function refresh(): Promise<void> {
    if (admissionClosed) return
    if (reading !== null) {
      readAgain = true
      return reading
    }
    if (admission.inventoryFailure()) return
    reading = (async () => {
      do {
        readAgain = false
        await readOnce().catch((err: unknown) => log(`refresh failed: ${String(err)}`))
      } while (readAgain && !admissionClosed && !admission.inventoryFailure())
    })()
    try {
      await reading
    } finally {
      reading = null
    }
  }

  async function release(c: Current): Promise<void> {
    const unwatch = c.unwatch
    c.unwatch = () => {}
    unwatch()
  }

  async function prepareOpen(c: Current): Promise<string | undefined> {
    // Taken here, at a terminal, not at vault open: a run that opens no
    // terminal must leave the notice for the one that does.
    if (c.spawnChecked) return undefined
    c.spawnChecked = true
    return firstSpawnNotice(provider, c.configDir)
  }

  async function openOn(
    c: Current,
    args: Geometry & { attach?: string; fork?: string },
    lease: PresentationLease,
  ) {
    if (!lease()) return vaultClosed
    const notice = await prepareOpen(c)
    if (!lease()) return vaultClosed
    if (args.attach !== undefined && inventory.unpublished.has(args.attach))
      return { ok: false as const, message: `Session ${args.attach} is still changing.` }
    return openPrepared(c, args, lease, notice)
  }

  function openPrepared(
    c: Current,
    args: Geometry & { attach?: string; fork?: string },
    lease: PresentationLease,
    notice?: string,
  ): { ok: true; terminalId: string } | Failure {
    if (!admittedFor(c, c.vault) || !lease())
      return { ok: false, message: 'The vault was left before the terminal opened.' }
    const target = targetOf(c)
    const res = deps.terminals.open({
      remote: c.remote,
      cwd: target.root,
      command: provider.terminal(target, {
        ...(args.attach === undefined ? {} : { attach: args.attach }),
        ...(args.fork === undefined ? {} : { fork: args.fork }),
      }),
      notInstalled: provider.notInstalled,
      ...(args.attach === undefined ? {} : { attach: args.attach }),
      ...(args.cols === undefined ? {} : { cols: args.cols }),
      ...(args.rows === undefined ? {} : { rows: args.rows }),
      ...(notice === undefined ? {} : { notice }),
      lease,
    })
    return res.ok ? { ok: true, terminalId: res.id } : res
  }

  const noVault = { ok: false as const, message: 'No vault is open.' }

  const api: AgentSessions = {
    async ensure(vault) {
      if (vault !== undefined) {
        if (
          attached !== null &&
          (attached.remote !== vault.remote || attached.root !== vault.root)
        ) {
          throw new Error('Agent session activation cannot change vault owner.')
        }
        attached ??= vault
      }
      await ensureCurrent()
    },

    sessions: summaries,
    past,
    refresh,

    async open(args, lease) {
      const owner = attached
      const c = await ensureCurrent()
      if (!admittedFor(c, owner) || !lease()) return noVault
      const notice = await prepareOpen(c)
      if (!lease()) return noVault
      if (args.attach !== undefined && inventory.unpublished.has(args.attach))
        return { ok: false, message: `Session ${args.attach} is still changing.` }
      return openPrepared(c, args, lease, notice)
    },

    async start({ name, prompt, model, allow, appendSystemPrompt, cols, rows: r }, lease) {
      const owner = attached
      const c = await ensureCurrent()
      if (!admittedFor(c, owner) || !lease())
        return { ok: false, message: 'The vault changed before the session started.' }
      const target = targetOf(c)
      const options = {
        ...(name === undefined ? {} : { name }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(model === undefined ? {} : { model }),
        ...(allow === undefined ? {} : { allow: [...allow] }),
        ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
      }
      return createBackground(
        c,
        target,
        () => bg.cli.startBg(target, options),
        { cols, rows: r, lease },
        prompt === undefined,
      )
    },

    async launch({ name, prompt, model, allow, deny, appendSystemPrompt, mcpConfig }) {
      const owner = attached
      const c = await ensureCurrent()
      if (!admittedFor(c, owner)) return noVault
      const target = targetOf(c)
      const options = {
        name,
        prompt,
        ...(model === undefined ? {} : { model }),
        ...(allow === undefined ? {} : { allow: [...allow] }),
        ...(deny === undefined ? {} : { deny: [...deny] }),
        ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
        ...(mcpConfig === undefined ? {} : { mcpConfig }),
      }
      return createBackground(c, target, () => bg.cli.startBg(target, options))
    },

    watched: (id) => !admissionClosed && deps.terminals.launchedFor(id) !== null,

    onTurnEnd(listener) {
      turnEnds.add(listener)
      return () => turnEnds.delete(listener)
    },
    onSessions(listener) {
      sessionListeners.add(listener)
      return () => void sessionListeners.delete(listener)
    },

    async send({ text, target, cols, rows: r }, lease) {
      const owner = attached
      const c = await ensureCurrent()
      if (!admittedFor(c, owner) || !lease()) return noVault
      let terminalId: string
      if (target === 'new') {
        // The CLI makes a name of the text's first line.
        const started = await api.start({ name: text, cols, rows: r }, lease)
        if (!started.ok) return started
        terminalId = started.terminalId
      } else {
        if (!live().some((row) => row.id === target)) {
          return { ok: false, message: 'That session has ended. Pick another one.' }
        }
        const existing = deps.terminals.launchedFor(target)
        if (existing !== null) terminalId = existing
        else {
          const opened = await openOn(c, { attach: target, cols, rows: r }, lease)
          if (!opened.ok) return opened
          terminalId = opened.terminalId
        }
      }
      if (!admittedFor(c, owner) || !lease())
        return { ok: false, message: 'The vault was left before the message was sent.' }
      if (
        !deps.terminals.claim(terminalId, lease) ||
        !deps.terminals.paste(terminalId, text, lease)
      )
        return vaultClosed
      return { ok: true, terminalId }
    },

    async stop(id) {
      const owner = attached
      const c = await ensureCurrent()
      return admittedFor(c, owner) ? changeSession(c, id, 'stop') : noVault
    },

    async respawn(id, lease) {
      const owner = attached
      const c = await ensureCurrent()
      return admittedFor(c, owner) && lease() ? changeSession(c, id, 'respawn', lease) : noVault
    },

    async duplicate(id, geometry = {}, lease) {
      const owner = attached
      const c = await ensureCurrent()
      if (!admittedFor(c, owner) || !lease()) return noVault
      const blocked = admission.creationBlock()
      if (blocked) return blocked
      const row = inventory.rows.find((r) => r.id === id)
      const conversation = row?.sessionId
      if (row === undefined || conversation === undefined) {
        return { ok: false, message: 'Claude Code has not said which conversation this is yet.' }
      }
      const label = bg.summarise(row, coordinator.working).name
      const name = label === 'New session' ? undefined : `${label} (copy)`
      const target = targetOf(c)
      return createBackground(c, target, () => bg.cli.forkBg(target, conversation, name), {
        ...geometry,
        lease,
      })
    },

    async noteTurn(remote, jobId, active, pending = null, pid) {
      // The hook can arrive as soon as a provider starts, before the initial
      // listing/config activation has completed. Its route is vault-scoped.
      if (attached?.remote !== remote) return null
      if (current === null) await ensureCurrent()
      if (current?.remote !== remote) return null
      let settled: Promise<string | null> = Promise.resolve(null)
      if (active) inventory.unprompted.delete(jobId)
      if (active && pid !== undefined)
        workingPid.set(jobId, { ...workingPid.get(jobId), hook: pid })
      if (active) coordinator.begin(jobId)
      else {
        if (pending !== null) stopPending.set(jobId, pending)
        settled = coordinator.end(jobId)
        stopPending.delete(jobId)
      }
      void refresh()
      return settled
    },

    noteStatus(remote, jobId, report) {
      if (attached?.remote !== remote) return
      if (current === null) {
        earlyStatus.set(jobId, report)
        return
      }
      if (current.remote !== remote) return
      applyStatus(jobId, report)
      push()
    },

    noteChannel(remote, jobId, channel) {
      if (attached?.remote !== remote) return
      if (current === null) {
        earlyChannels.set(jobId, channel)
        return
      }
      if (current.remote === remote) channels.set(jobId, channel)
    },

    async message(id, text) {
      const owner = attached
      const c = await ensureCurrent()
      if (!admittedFor(c, owner)) throw new CapabilityError('UNAVAILABLE', noVault.message)
      if (!live().some((row) => row.id === id)) {
        throw new CapabilityError('NOT_FOUND', `no running session ${id}`)
      }
      const channel = channels.get(id)
      if (channel === undefined) {
        throw new CapabilityError(
          'UNAVAILABLE',
          `session ${id} has not said where it takes messages`,
          "it says so as it starts and at each turn through the vault's turn-signal hook; " +
            'run `holi skills update` if the vault predates it',
        )
      }
      try {
        await bg.message(channel, text, lifetime.signal)
        if (admissionClosed || current !== c)
          throw new CapabilityError(
            'UNAVAILABLE',
            'The vault was left before the message completed.',
          )
      } catch (error) {
        // Not tried again until the session reports it anew, at its next turn
        // or its next process: a gone socket stays gone.
        if (channels.get(id) === channel) channels.delete(id)
        throw error
      }
    },

    setFocus(focus) {
      const vault = attached
      if (vault === null) return
      if (admissionClosed) return
      if (focusWriter?.root !== vault.root) {
        if (focusWriter !== null) {
          focusStop = focusWriter.snapshot.stop().catch((error: unknown) => {
            focusStopFailure = error
          })
        }
        focusWriter = { root: vault.root, snapshot: new ContextSnapshot({ workRoot: vault.root }) }
        focusStop = null
        focusStopFailure = null
      }
      focusWriter.snapshot.setFocus(focus)
    },

    bracket(id, edge) {
      if (edge === 'begin') {
        if (admissionClosed || activationSignal?.aborted) return
        bracketed.add(id)
        coordinator.begin(id)
        return
      }
      if (edge === 'end') {
        if (!bracketed.delete(id)) return null
        return coordinator.end(id)
      }
      bracketed.delete(id)
      coordinator.forget(id)
    },

    async leave({ stopSessions = true } = {}) {
      if (leaving !== null) return leaving
      if (drainFailure !== null) throw drainFailure
      revoke()
      const unwatch = current?.unwatch
      if (current !== null) current.unwatch = () => {}
      try {
        unwatch?.()
      } catch (error) {
        lateCleanup.recordFailure(error)
      }
      leaving = leaveNow(stopSessions)
      try {
        await leaving
      } finally {
        leaving = null
      }
    },
  }

  async function leaveNow(stopSessions: boolean): Promise<void> {
    const failures: unknown[] = []
    // A vault still attaching is the one being left: let it land first.
    if (activating !== null) {
      try {
        await activating
      } catch (error) {
        failures.push(error)
      }
    }
    attached = null
    while (operations.pending.size > 0 || lateCleanup.pending.length > 0 || reading !== null) {
      await Promise.allSettled([
        ...operations.pending,
        ...lateCleanup.pending,
        ...(reading === null ? [] : [reading]),
      ])
    }
    await Promise.all(
      lateCleanup
        .failures()
        .flatMap((error) => (error instanceof Error ? [admission.revokeUnconfirmed(error)] : [])),
    )
    const c = current
    if (c === null) {
      try {
        await coordinator.drain()
      } catch (error) {
        failures.push(error)
      }
      try {
        await focusStop
      } catch (error) {
        failures.push(error)
      }
      if (focusStopFailure !== null) failures.push(focusStopFailure)
      focusStop = null
      focusStopFailure = null
      focusWriter = null
      finishDrain(failures)
      return
    }
    if (stopSessions) {
      const shutdownIds = new Set([
        ...inventory.listed,
        ...inventory.pending,
        ...inventory.uncertain.keys(),
      ])
      // Uncertain ids are drained via their original lease above, never by
      // issuing another verb. Stop the rest, then remove unprompted sessions.
      const stops = Promise.allSettled(
        [...shutdownIds]
          .filter((id) => !inventory.uncertain.has(id) && !inventory.unpublished.has(id))
          .map(async (id) => {
            const target = targetOf(c)
            try {
              await stopProvider(target, id)
            } catch (error) {
              if (error instanceof UnconfirmedOwnedProgramError) {
                admission.retainFailure(unconfirmed(error, id))
                await admission.revokeUnconfirmed(error)
                return
              }
              throw error
            }
            if (inventory.unprompted.has(id)) {
              const removed = await bg.cli.rm(target, id)
              if (!removed.ok) {
                if (removed.cleanupUnconfirmed) {
                  admission.retainFailure(unconfirmed(removed.error, id))
                  await admission.revokeUnconfirmed(removed.error)
                  return
                }
                throw (
                  removed.error ?? new Error(`Could not remove session ${id}: ${removed.message}`)
                )
              }
            }
          }),
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut =
        process.platform === 'win32'
          ? null
          : new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error('Agent sessions did not stop before vault teardown timed out.')),
                deps.leaveCapMs ?? LEAVE_CAP_MS,
              )
            })
      try {
        // The native command and lease own their deadlines on Windows. A
        // presentation timeout cannot stand in for joining that cleanup.
        const results = await (timedOut === null ? stops : Promise.race([stops, timedOut]))
        failures.push(
          ...results
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map((result) => result.reason),
        )
      } catch (error) {
        failures.push(error)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    try {
      await deps.terminals.closeAll()
    } catch (error) {
      failures.push(error)
    }
    for (const id of [...coordinator.working]) coordinator.forget(id)
    try {
      await coordinator.drain()
    } catch (error) {
      failures.push(error)
    }
    bracketed.clear()
    workingPid.clear()
    inventory.unprompted.clear()
    contextPercent.clear()
    modelName.clear()
    channels.clear()
    earlyStatus.clear()
    earlyChannels.clear()
    listedLive = new Set()
    if (idleRecheck !== null) {
      clearTimeout(idleRecheck)
      idleRecheck = null
    }
    try {
      await (focusStop ?? focusWriter?.snapshot.stop())
    } catch (error) {
      focusStopFailure ??= error
    }
    if (focusStopFailure !== null) failures.push(focusStopFailure)
    focusStopFailure = null
    focusStop = null
    focusWriter = null
    current = null
    inventory.rows = []
    try {
      await release(c)
    } catch (error) {
      failures.push(error)
    }
    push(c.remote)
    pushPast(c.remote)
    finishDrain(failures)
  }

  function finishDrain(failures: unknown[]): void {
    const all = [...new Set([...failures, ...lateCleanup.failures()])]
    if (all.length > 0) {
      drainFailure = new AggregateError(all, 'Agent session teardown failed.')
      throw drainFailure
    }
  }
  const operations = createOwnedOperationTracker(
    () => !admissionClosed && !activationSignal?.aborted && leaving === null,
  )
  return {
    ...admitAgentSessions(
      api,
      operations,
      () => admissionClosed || deps.activationSignal?.aborted === true,
    ),
    protectPtyTurn(id) {
      if (!bracketed.has(id)) return
      const release = coordinator.protectPtyTurn(id)
      if (!release) return
      return () => {
        bracketed.delete(id)
        release()
      }
    },
  }
}
