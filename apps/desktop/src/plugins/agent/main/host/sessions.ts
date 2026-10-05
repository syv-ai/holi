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
import type { TranscriptChunk } from '../claude/transcript'
import type { VaultCtx } from '../../../../main/plugin-api'
import type { VaultCliTarget } from '../claude/cli'
import type { ClaudeRow, PastSession, SessionSummary } from '../claude/listing'
import type { AgentProvider, VaultRef } from '../provider'
import type { AgentTerminals } from './terminals'
import { readArchive, writeArchive } from './archive'
import { saveUpload, type UploadResult } from './uploads'
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
export type AgentVault = Pick<VaultCtx, 'remote' | 'root'> & TurnVault

export interface AgentSessionsDeps {
  /** Tell the renderer `name` about the vault `remote`. */
  emit(remote: string, name: string, payload: unknown): void
  provider: Pick<
    AgentProvider,
    | 'cli'
    | 'parseListing'
    | 'isLive'
    | 'summarise'
    | 'summarisePast'
    | 'readContextPercent'
    | 'watch'
    | 'configure'
    | 'transcript'
    | 'blockedQuestion'
    | 'takeFirstSpawn'
    | 'signInNotice'
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
  /** The vault's finished sessions: its history, in listing order. */
  history(): PastSession[]
  /** Re-read the listing now. Never rejects. */
  refresh(): Promise<void>
  /** A terminal on the list (no `attach`) or on one session. */
  open(args: Geometry & { attach?: string }): Promise<OpenResult>
  /** A new background session, and a terminal on it. With a prompt, that
   *  prompt is its first turn (reconcile); without, it waits for one. */
  start(args: Geometry & { name?: string; prompt?: string }): Promise<StartResult>
  /** Put text in a session's input, unsent: a live one by id, or a new one
   *  named from the text. Opens a terminal on it when Holi has none. */
  send(args: Geometry & { text: string; target: string | 'new' }): Promise<OpenResult>
  /** Send `text` to a live session as a turn, through a terminal on it. */
  say(args: Geometry & { id: string; text: string }): Promise<OpenResult>
  /** The archived chats' job ids. */
  archived(): string[]
  /** Archive a chat, or bring it back. Never stops a session: the caller
   *  stops a live one first. */
  archive(id: string, archived: boolean): Promise<ActionResult>
  /** Delete a finished chat for good, conversation and all (`claude rm`). */
  remove(id: string): Promise<ActionResult>
  /** Write an image the person attached into the vault; answers its path. */
  upload(args: { name: string; data: string }): Promise<UploadResult>
  /** A live session's conversation from `offset` on. */
  transcript(id: string, offset?: number): Promise<TranscriptChunk | null>
  /** The question a session waits on, as JSON, when only Claude Code's job
   *  record has it. */
  question(id: string): Promise<string | null>
  stop(id: string): Promise<ActionResult>
  respawn(id: string): Promise<ActionResult>
  duplicate(id: string, geometry?: Geometry): Promise<StartResult>
  /** A turn edge from the seeded hook, by vault and job id. */
  noteTurn(remote: string, jobId: string, active: boolean): void
  /** A session's status line fired: Claude Code's status JSON, by vault and
   *  job id. */
  noteStatus(remote: string, jobId: string, status: unknown): void
  /** The focus file is the vault's, so this names no session. */
  setFocus(focus: FocusInput): void
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
  /** The archived chats, by job id (`archive.ts`). */
  archived: Set<string>
}

export function createAgentSessions(deps: AgentSessionsDeps): AgentSessions {
  const log = deps.log ?? ((msg: string) => console.log(`[agent] ${msg}`))
  const provider = deps.provider
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
  let lastHistory = ''
  let lastArchive = ''
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
  /**
   * Each live session's context use, by job id, from its status line. Claude
   * Code's listing does not carry it. The status line runs on Claude Code's
   * own events, a background session with no client attached included, and a
   * session between turns is not using any more.
   */
  const contextPercent = new Map<string, number>()

  const coordinator: TurnCoordinator = createTurnCoordinator({
    vault: () => current?.vault ?? null,
    ...(deps.turnLogFor === undefined ? {} : { turnLogFor: deps.turnLogFor }),
    ...(deps.turnSafetyMs === undefined ? {} : { turnSafetyMs: deps.turnSafetyMs }),
    ...(deps.idleConfirmMs === undefined ? {} : { idleConfirmMs: deps.idleConfirmMs }),
    onChange: () => push(),
    log,
  })

  const live = (): ClaudeRow[] => rows.filter((row) => provider.isLive(row))
  const summaries = (): SessionSummary[] =>
    live().map((row) => provider.summarise(row, coordinator.working, contextPercent.get(row.id)))
  const past = (): PastSession[] =>
    rows.filter((row) => !provider.isLive(row)).map((row) => provider.summarisePast(row))

  /** Tell the renderer the list, when it changed: the vault's, or `remote`'s
   *  as Holi lets go of it. */
  function push(remote = current?.remote): void {
    if (remote === undefined) return
    const next = summaries()
    const encoded = JSON.stringify(next)
    if (encoded !== lastPushed) {
      lastPushed = encoded
      deps.emit(remote, 'sessions', next)
    }
    // The history moves far less often than the sessions do and rides the
    // same read, so it is told only when it differs.
    const history = past()
    const encodedHistory = JSON.stringify(history)
    if (encodedHistory !== lastHistory) {
      lastHistory = encodedHistory
      deps.emit(remote, 'history', history)
    }
    const archived = [...(current?.archived ?? [])]
    const encodedArchive = JSON.stringify(archived)
    if (encodedArchive !== lastArchive) {
      lastArchive = encodedArchive
      deps.emit(remote, 'archive', archived)
    }
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
      archived: new Set(await readArchive(vault.root)),
    }
    next.unwatch = provider.watch(config.dir, () => void refresh(), log)
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
    const stdout = await provider.cli.list(targetOf(c))
    if (current !== c) return // the vault moved while we read
    rows = provider.parseListing(stdout, c.root)
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

    // A session whose process has gone will not end its turn now.
    for (const id of coordinator.working) if (!liveIds.has(id)) coordinator.forget(id)
    // Nor use any more context; resumed, it says so again at its first event.
    for (const id of contextPercent.keys()) if (!liveIds.has(id)) contextPercent.delete(id)

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

  async function openOn(c: Current, args: Geometry & { attach?: string }): Promise<OpenResult> {
    // Taken here, at a terminal, not at vault open: a run that opens no
    // terminal must leave the notice for the one that does.
    let firstSpawn = false
    if (!c.spawnChecked) {
      c.spawnChecked = true
      firstSpawn = await provider.takeFirstSpawn(c.configDir).catch(() => false)
    }
    const notice = firstSpawn ? provider.signInNotice : undefined
    const res = deps.terminals.open({
      remote: c.remote,
      target: targetOf(c),
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
    history: past,
    archived: () => [...(current?.archived ?? [])],
    async archive(id, archived) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      if (archived) c.archived.add(id)
      else c.archived.delete(id)
      await writeArchive(c.root, c.archived).catch((err: unknown) =>
        log(`archive not saved: ${String(err)}`),
      )
      push()
      return { ok: true }
    },
    async remove(id) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      if (live().some((row) => row.id === id)) {
        return { ok: false, message: 'That session is still running. Stop it first.' }
      }
      const res = await provider.cli.rm(targetOf(c), id)
      if (res.ok) {
        c.archived.delete(id)
        await writeArchive(c.root, c.archived).catch(() => {})
      }
      await refresh()
      return res
    },
    refresh,

    async open(args) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      return openOn(c, args)
    },

    async start({ name, prompt, cols, rows: r }) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      const res = await provider.cli.startBg(targetOf(c), {
        ...(name === undefined ? {} : { name }),
        ...(prompt === undefined ? {} : { prompt }),
      })
      if (!res.ok) return res
      if (prompt === undefined) unprompted.add(res.id)
      await refresh()
      const opened = await openOn(c, { attach: res.id, cols, rows: r })
      return opened.ok ? { ok: true, sessionId: res.id, terminalId: opened.terminalId } : opened
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

    async say({ id, text, cols, rows: r }) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      if (!live().some((row) => row.id === id)) {
        return { ok: false, message: 'That session has ended.' }
      }
      let terminalId = deps.terminals.launchedFor(id)
      if (terminalId === null) {
        const opened = await openOn(c, { attach: id, cols, rows: r })
        if (!opened.ok) return opened
        terminalId = opened.terminalId
      }
      deps.terminals.paste(terminalId, text, true)
      unprompted.delete(id)
      return { ok: true, terminalId }
    },

    async upload(args) {
      const c = await ensureCurrent()
      return c === null ? noVault : saveUpload(c.root, args)
    },

    async transcript(id, offset) {
      const c = await ensureCurrent()
      const sessionId = rows.find((row) => row.id === id)?.sessionId
      if (c === null || sessionId === undefined) return null
      return provider.transcript(c.configDir, sessionId, offset)
    },

    async question(id) {
      const c = await ensureCurrent()
      if (c === null || !rows.some((row) => row.id === id)) return null
      return provider.blockedQuestion(c.configDir, id)
    },

    async stop(id) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      const res = await provider.cli.stop(targetOf(c), id)
      await refresh()
      return res
    },

    async respawn(id) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      const res = await provider.cli.respawn(targetOf(c), id)
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
      const label = provider.summarise(row, coordinator.working).name
      const name = label === 'New session' ? undefined : `${label} (copy)`
      const res = await provider.cli.forkBg(targetOf(c), row.sessionId, name)
      if (!res.ok) return res
      await refresh()
      const opened = await openOn(c, { attach: res.id, ...geometry })
      return opened.ok ? { ok: true, sessionId: res.id, terminalId: opened.terminalId } : opened
    },

    noteTurn(remote, jobId, active) {
      // A turn in a vault Holi is not showing is not this vault's pause.
      if (current?.remote !== remote) return
      if (active) unprompted.delete(jobId)
      if (active) coordinator.begin(jobId)
      else coordinator.end(jobId)
      void refresh()
    },

    noteStatus(remote, jobId, status) {
      // Only the vault Holi is showing has rows to put a number on.
      if (current?.remote !== remote) return
      const percent = provider.readContextPercent(status)
      if (percent === null) contextPercent.delete(jobId)
      else contextPercent.set(jobId, percent)
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
          const stopped = await provider.cli.stop(targetOf(c), row.id)
          if (stopped.ok && unprompted.has(row.id)) await provider.cli.rm(targetOf(c), row.id)
        }),
      )
      await Promise.race([
        stops,
        new Promise((r) => setTimeout(r, deps.leaveCapMs ?? LEAVE_CAP_MS)),
      ])
    }
    await deps.terminals.closeAll()
    for (const id of [...coordinator.working]) coordinator.forget(id)
    unprompted.clear()
    contextPercent.clear()
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
