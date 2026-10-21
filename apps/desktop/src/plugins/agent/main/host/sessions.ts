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
 * Two things belong to the **vault**, not to any session, and live here: the
 * config directory and the focus file the per-turn hook reads.
 *
 * **Holi does not decide what a session is doing.** `session-state.ts` does:
 * the listing says so, the hook bracket stays as the floor under it, and the
 * sync pause is the turn coordinator's behind it. This module hands it the
 * vault's listing and the hook's edges, and asks it for the sessions.
 *
 * The session list is told to the renderer as the agent's `sessions` event,
 * whenever it changes.
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import { CapabilityError, type PluginCtx } from '../../../../main/plugin-api'
import type { EarlierChunk, TranscriptChunk } from '../claude/transcript'
import type { StartBgOptions, VaultCliTarget } from '../claude/cli'
import type { ClaudeRow, PastSession, SessionSummary } from '../claude/listing'
import type { SessionChannel } from '../claude/messaging'
import type { AgentProvider, VaultRef } from '../provider'
import type { AgentTerminals, TerminalSink } from './terminals'
import { readArchive, writeArchive } from './archive'
import { saveUpload, type UploadResult } from './uploads'
import { ContextSnapshot, type FocusInput } from './context-snapshot'
import { createSessionState, type ListingSource } from './session-state'
import type { TurnVault } from './turn-coordinator'
import type { TurnLog } from './turn-log'

/** The cap on stopping sessions as Holi leaves a vault: a hung CLI must not
 *  hold a vault switch or a quit. */
const LEAVE_CAP_MS = 5_000

export type ActionResult = { ok: true } | { ok: false; message: string }
export type OpenResult = { ok: true; terminalId: string } | { ok: false; message: string }
export type StartResult =
  { ok: true; sessionId: string; terminalId: string } | { ok: false; message: string }
export type LaunchResult = { ok: true; sessionId: string } | { ok: false; message: string }

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
    | 'transcriptEarlier'
    | 'subagent'
    | 'setLogger'
    | 'blockedQuestion'
    | 'takeFirstSpawn'
    | 'signInNotice'
    | 'message'
  >
  terminals: AgentTerminals
  /** Holi's generated commands, first on every session's `PATH`. */
  binDir(): string | null
  /** Whether Holi holds a question this session is waiting on (the question
   *  desk). Such a session needs you, whatever the listing says. */
  pendingQuestion?(jobId: string): boolean
  turnLogFor?: (vaultRoot: string) => TurnLog
  /** See `TurnCoordinatorDeps.snapshot`. */
  snapshot?: (vaultRoot: string) => Promise<string | null>
  turnSafetyMs?: number
  idleRecheckMs?: number
  /** Forwarded to the session state's turn coordinator. */
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
  /** A terminal on the list (no `attach`) or on one session. With `sink`, the
   *  quick panel's own: not a tab (`terminals.ts`). */
  open(args: Geometry & { attach?: string; sink?: TerminalSink }): Promise<OpenResult>
  /** A new background session, and a terminal on it. With a prompt, that
   *  prompt is its first turn (reconcile); without, it waits for one. */
  start(args: Geometry & { name?: string; prompt?: string }): Promise<StartResult>
  /** A new background session whose first turn is `prompt`, and no
   *  terminal: nobody is watching it start. A scheduled run, or a quick agent
   *  with its options. */
  launch(args: Omit<StartBgOptions, 'prompt'> & { prompt: string }): Promise<LaunchResult>
  /** Its row in the latest listing, live or not. */
  row(id: string): ClaudeRow | undefined
  /** The turn coordinator holds it in a turn (what makes a row working in
   *  the session list). */
  inTurn(id: string): boolean
  /** Hear every listing read, and the vault being left. Returns the undo. */
  onRows(cb: () => void): () => void
  /** Push the list again: something Holi holds about a session changed (a
   *  question arrived or was answered). */
  touch(): void
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
  transcript(id: string, offset?: number, fingerprint?: string): Promise<TranscriptChunk | null>
  /** The part of a live session's conversation before `before`, a line start
   *  of the transcript (a chunk's `start`). */
  transcriptEarlier(id: string, before: number): Promise<EarlierChunk | null>
  /** A sub-agent's conversation of a live session, from `offset` on. */
  subagent(
    id: string,
    agentId: string,
    offset?: number,
    fingerprint?: string,
  ): Promise<TranscriptChunk | null>
  /** The question a session waits on, as JSON, when only Claude Code's job
   *  record has it. */
  question(id: string): Promise<string | null>
  stop(id: string): Promise<ActionResult>
  respawn(id: string): Promise<ActionResult>
  duplicate(id: string, geometry?: Geometry): Promise<StartResult>
  /** A turn edge from the seeded hook, by vault and job id. */
  noteTurn(remote: string, jobId: string, active: boolean, pending?: number | null): void
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
  /** Where this vault's listing is read from. */
  source: ListingSource
  /** The archived chats, by job id (`archive.ts`). */
  archived: Set<string>
}

export function createAgentSessions(deps: AgentSessionsDeps): AgentSessions {
  const log = deps.log ?? ((msg: string) => console.log(`[agent] ${msg}`))
  const provider = deps.provider
  provider.setLogger?.(log)
  let current: Current | null = null
  /** The vault `ensure` attached to, until `leave`. */
  let attached: AgentVault | null = null
  let activating: Promise<Current | null> | null = null
  /** Set while `leave` runs: nothing may attach to a vault on its way out,
   *  which would watch a directory Holi is letting go of. */
  let leaving: Promise<void> | null = null
  let lastPushed = ''
  let lastHistory = ''
  let lastArchive = ''
  let focusWriter: { root: string; snapshot: ContextSnapshot } | null = null
  /**
   * Where each session takes messages, by job id, as its hooks reported it.
   * In memory only: the token is the session's, and a file would outlive it.
   * Dropped when the session leaves the live listing, when a write to it
   * fails, and when Holi lets go of the vault. A session is told apart
   * from one not yet listed by `listedLive`: a `SessionStart` report can
   * arrive before the listing shows the session at all.
   */
  const channels = new Map<string, SessionChannel>()
  let listedLive = new Set<string>()
  const rowListeners = new Set<() => void>()
  const rowsChanged = (): void => {
    for (const cb of [...rowListeners]) cb()
  }
  const sessionListeners = new Set<(sessions: SessionSummary[]) => void>()

  const state = createSessionState({
    source: () => current?.source ?? null,
    vault: () => current?.vault ?? null,
    provider,
    onChange: () => push(),
    onRead(liveIds) {
      // A session that left the live listing takes no more messages: a
      // resumed process binds a new inbox and says so.
      for (const id of channels.keys())
        if (listedLive.has(id) && !liveIds.has(id)) channels.delete(id)
      listedLive = new Set(liveIds)
      rowsChanged()
    },
    ...(deps.pendingQuestion === undefined
      ? {}
      : { heldQuestion: (id: string) => deps.pendingQuestion?.(id) === true }),
    ...(deps.turnLogFor === undefined ? {} : { turnLogFor: deps.turnLogFor }),
    ...(deps.snapshot === undefined ? {} : { snapshot: deps.snapshot }),
    ...(deps.turnSafetyMs === undefined ? {} : { turnSafetyMs: deps.turnSafetyMs }),
    ...(deps.idleConfirmMs === undefined ? {} : { idleConfirmMs: deps.idleConfirmMs }),
    ...(deps.idleRecheckMs === undefined ? {} : { idleRecheckMs: deps.idleRecheckMs }),
    log,
  })
  const refresh = state.refresh

  /** Tell the renderer the list, when it changed: the vault's, or `remote`'s
   *  as Holi lets go of it. */
  function push(remote = current?.remote): void {
    if (remote === undefined) return
    const next = state.sessions()
    const encoded = JSON.stringify(next)
    if (encoded !== lastPushed) {
      lastPushed = encoded
      deps.emit(remote, 'sessions', next)
      for (const listener of sessionListeners) listener(next)
    }
    // The history moves far less often than the sessions do and rides the
    // same read, so it is told only when it differs.
    const history = state.history()
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
      source: {
        root: vault.root,
        read: () =>
          provider.cli.list({ root: vault.root, configDir: config.dir, binDir: deps.binDir() }),
      },
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

  async function release(c: Current): Promise<void> {
    c.unwatch()
  }

  async function openOn(
    c: Current,
    args: Geometry & { attach?: string; sink?: TerminalSink },
  ): Promise<OpenResult> {
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
      ...(args.sink === undefined ? {} : { sink: args.sink }),
    })
    return res.ok ? { ok: true, terminalId: res.id } : res
  }

  const noVault = { ok: false as const, message: 'No vault is open.' }

  const api: AgentSessions = {
    async ensure(vault) {
      if (vault !== undefined) attached = vault
      await ensureCurrent()
    },

    sessions: state.sessions,
    history: state.history,
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
      if (state.isLive(id)) {
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
      if (prompt === undefined) state.startedEmpty(res.id)
      else state.startedWithPrompt(res.id)
      await refresh()
      const opened = await openOn(c, { attach: res.id, cols, rows: r })
      return opened.ok ? { ok: true, sessionId: res.id, terminalId: opened.terminalId } : opened
    },

    async launch(args) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      const res = await provider.cli.startBg(targetOf(c), args)
      if (!res.ok) return res
      if (current !== c) {
        // The leave read the sessions to stop before this one was listed, so
        // it would go on running in the vault left while its caller is told
        // it failed: stop it here.
        await provider.cli.stop(targetOf(c), res.id)
        return { ok: false, message: 'The vault closed as the session started.' }
      }
      state.startedWithPrompt(res.id)
      await refresh()
      return { ok: true, sessionId: res.id }
    },

    row: state.row,

    inTurn: state.inTurn,

    onRows(cb) {
      rowListeners.add(cb)
      return () => void rowListeners.delete(cb)
    },

    touch: () => push(),

    watched: (id) => deps.terminals.launchedFor(id) !== null,

    onTurnEnd: state.onTurnEnd,
    onSessions(listener) {
      sessionListeners.add(listener)
      return () => void sessionListeners.delete(listener)
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
        if (!state.isLive(target)) {
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
      if (!state.isLive(id)) {
        return { ok: false, message: 'That session has ended.' }
      }
      let terminalId = deps.terminals.launchedFor(id)
      if (terminalId === null) {
        const opened = await openOn(c, { attach: id, cols, rows: r })
        if (!opened.ok) return opened
        terminalId = opened.terminalId
      }
      deps.terminals.paste(terminalId, text, true)
      state.spoke(id)
      return { ok: true, terminalId }
    },

    async upload(args) {
      const c = await ensureCurrent()
      return c === null ? noVault : saveUpload(c.root, args)
    },

    async transcript(id, offset, fingerprint) {
      const c = await ensureCurrent()
      const sessionId = state.row(id)?.sessionId
      if (c === null || sessionId === undefined) return null
      return provider.transcript(c.configDir, sessionId, offset, fingerprint)
    },

    async transcriptEarlier(id, before) {
      const c = await ensureCurrent()
      const sessionId = state.row(id)?.sessionId
      if (c === null || sessionId === undefined || provider.transcriptEarlier === undefined) {
        return null
      }
      return provider.transcriptEarlier(c.configDir, sessionId, before)
    },

    async subagent(id, agentId, offset, fingerprint) {
      const c = await ensureCurrent()
      const sessionId = state.row(id)?.sessionId
      if (c === null || sessionId === undefined || provider.subagent === undefined) return null
      return provider.subagent(c.configDir, sessionId, agentId, offset, fingerprint)
    },

    async question(id) {
      const c = await ensureCurrent()
      if (c === null || state.row(id) === undefined) return null
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
      const row = state.row(id)
      if (row?.sessionId === undefined) {
        return { ok: false, message: 'Claude Code has not said which conversation this is yet.' }
      }
      const label = state.nameOf(id) ?? ''
      const name = label === 'New session' ? undefined : `${label} (copy)`
      const res = await provider.cli.forkBg(targetOf(c), row.sessionId, name)
      if (!res.ok) return res
      await refresh()
      const opened = await openOn(c, { attach: res.id, ...geometry })
      return opened.ok ? { ok: true, sessionId: res.id, terminalId: opened.terminalId } : opened
    },

    noteTurn(remote, jobId, active, pending = null) {
      // A turn in a vault Holi is not showing is not this vault's pause.
      if (current?.remote !== remote) return
      state.noteTurn(jobId, active, pending)
    },

    noteStatus(remote, jobId, status) {
      // Only the vault Holi is showing has rows to put a number on.
      if (current?.remote !== remote) return
      state.noteStatus(jobId, status)
    },

    noteChannel(remote, jobId, channel) {
      if (current?.remote !== remote) return
      channels.set(jobId, channel)
    },

    async message(id, text) {
      const c = await ensureCurrent()
      if (c === null) throw new CapabilityError('UNAVAILABLE', noVault.message)
      if (!state.isLive(id)) {
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
        await provider.message(channel, text)
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
      // Stop, then remove the ones that never had a turn.
      const stops = Promise.all(
        state.liveIds().map(async (id) => {
          const stopped = await provider.cli.stop(targetOf(c), id)
          if (stopped.ok && state.hasHadNoTurn(id)) await provider.cli.rm(targetOf(c), id)
        }),
      )
      await Promise.race([
        stops,
        new Promise((r) => setTimeout(r, deps.leaveCapMs ?? LEAVE_CAP_MS)),
      ])
    }
    await deps.terminals.closeAll()
    state.reset()
    channels.clear()
    listedLive = new Set()
    focusWriter?.snapshot.stop()
    focusWriter = null
    current = null
    await release(c)
    push(c.remote)
    rowsChanged()
  }
  return api
}
