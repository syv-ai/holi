/**
 * Session orchestration: owns the vault's live `claude` sessions — each one's
 * PTY, its terminal mirror, its bearers — and ties them to the active vault.
 *
 * **A vault runs any number of them (D100).** What used to be one session and a
 * restart is now a map: `start` adds, `kill` removes the one it is given, and
 * every route in and out carries the session's id. The three things that stay
 * singular are the ones that belong to the *vault* rather than to a session: the
 * focus file the per-turn hook reads, the sync pause (which the turn coordinator
 * owns), and the Claude Code config directory D86 gave each vault.
 *
 * **Holi does not decide what a session is doing.** Whether one is working,
 * waiting for you, or idle, and what it is called, are facts Claude Code
 * maintains and publishes; `session-registry.ts` reads them and this module
 * joins them to its own sessions by pid. The hook bracket stays as the floor
 * under that join, because a missing or slow CLI must still report a live turn —
 * and because the sync pause has a deadline a watcher cannot meet.
 *
 * Pure Claude Code (prd/agent.md): no MCP surface, no built system prompt, no
 * turn protocol, no presence. The agent's whole surface is its native tools on
 * the vault's files; Holi's only per-turn injection is the focused-note line,
 * written by the focus writer.
 *
 * NOTE: no runtime `electron` import (types only). The window arrives through
 * `getWindow()`, so this module loads under vitest.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { AGENT_CONFIG_FILES } from '@holi/shared'
import type { VaultHost } from '../vault/active-vault'
import type { TurnLog } from './turn-log'
import {
  AgentRuntime,
  buildAgentArgs,
  buildAgentEnv,
  resolveClaudeBin,
  sessionName,
  type SpawnPty,
} from './agent-runtime'
import type { AgentConfigResolution } from './agent-config-dir'
import { ContextSnapshot, type FocusInput } from './context-snapshot'
import type { SessionRegistry, SessionRow } from './session-registry'
import { createTurnCoordinator, type TurnCoordinator } from './turn-coordinator'
import { TerminalMirror } from './terminal-mirror'

/**
 * Printed into the terminal record the first time Holi spawns an agent in a
 * vault's config directory (§6 of the isolation spec, unbuilt until D86).
 *
 * First-spawn rather than a read of Claude Code's sign-in state, because that
 * state cannot be read honestly — see `takeFirstSpawn`. A directory Holi has
 * never spawned in cannot hold a credential, since credentials are keyed to the
 * directory, so the proxy is exact where it matters.
 *
 * **In the scrollback, not the panel header**, and that is D72's own argument
 * rather than a walk-back of it: a header notice is duplicate state, and `/login`
 * fires no spawn, no turn and no exit, so the copy in Holi's chrome goes stale
 * the moment it matters. A line printed at spawn is a log entry, and stays true
 * about that spawn.
 *
 * It says the per-vault part out loud, because a second `/login` on a machine
 * that already has one otherwise reads as a bug.
 */
const SIGN_IN_NOTICE =
  '\x1b[33mThis vault needs its own Claude sign-in. Type /login below.\r\n' +
  'Each vault keeps its own Claude Code config, so signing in here\r\n' +
  'does not touch your other vaults.\x1b[0m\r\n\r\n'

/**
 * What a session is called before it has a name of its own.
 *
 * Claude Code gives an unnamed session a placeholder built from its cwd, which
 * is the **same string for every session in one vault** — so showing it would
 * label three tabs identically. See `deriveName` for how the two are told apart.
 */
const NEW_SESSION = 'New session'

/** How long after an `idle` reading to take the second one that confirms it.
 *  A quiet session produces no watcher edge, so nothing else would. */
const IDLE_RECHECK_MS = 1_100

/**
 * Text pasted into a session's input box, unsent (D100).
 *
 * The framing is the terminal's own: everything between the two escapes is
 * pasted content rather than keystrokes, which is why a multi-line ask arrives
 * as one thing. **There is no `\r`.** An ask lands in the composer and the
 * person sends it, so nothing Holi writes can submit a draft they were still
 * typing.
 */
const bracketedPaste = (text: string): string => `\x1b[200~${text}\x1b[201~`

/**
 * How long a session is treated as not yet ready to be pasted into.
 *
 * Ready means the registry has sighted it, which happens because Claude Code
 * writes its session file at `SessionStart` — measured 0.94 s after the spawn,
 * and measured as the point where a paste lands in the composer rather than into
 * a TUI that is not reading stdin yet. This is the backstop for a listing that
 * never answers at all: the registry degrades honestly everywhere else, and text
 * the user has already written is not the thing to lose to it. After it elapses
 * a session is called ready on the grounds that 5 s is five times the measured
 * figure, so a paste is never delayed twice.
 */
const PASTE_BACKSTOP_MS = 5_000

export type SessionState = 'needs-you' | 'working' | 'idle'

export interface SessionSummary {
  id: string
  /**
   * The registry's name when it is a real one, else 'New session'. It is real if
   * Holi passed `--name` at spawn, or if the row's name has changed since the
   * first read after that spawn, which is what a `/name` looks like from
   * outside. The listing does not carry `nameSource` (2.1.278), so that
   * inference is the discriminator until it does.
   */
  name: string
  state: SessionState
  /** Present only for 'needs-you': the registry's reason, e.g. 'permission
   *  prompt'. Absent when the listing says `waiting` without saying why. */
  waitingFor?: string
  /** A synced agent-config file (`AGENT_CONFIG_FILES`) changed on disk since
   *  this session launched, so it is running against stale config until it
   *  restarts. Sticky until then, which is what actually re-reads config. */
  configStale: boolean
  /** Its PTY is gone. The session stays in the list — and keeps its scrollback —
   *  until someone closes it, so an exit is something you can read rather than a
   *  tab that vanishes. */
  exited: boolean
}

export interface AgentManagerDeps {
  host: VaultHost
  getWindow(): BrowserWindow | null
  spawnPty?: SpawnPty
  resolveBin?: () => string | null
  killGraceMs?: number
  /** Cap on waiting for the exit event after SIGKILL. Forwarded to
   *  `AgentRuntime`, which is the whole reason it is here: `killGraceMs` was
   *  threaded and this was not, so a test that set the grace to 20ms still
   *  waited out the 5s backstop on every kill. */
  killBackstopMs?: number
  /** The live hook-server port/token, injected into the child so its seeded
   *  curl hooks can reach us. Read per-spawn (the server outlives sessions). */
  hookPort?: () => number | null
  /** Mint the hook bearer for **this vault, this session**, and revoke it on
   *  teardown — the same reason as the Google one: the ops behind it act on a
   *  vault's files, and a session outlives a vault switch. The session id is
   *  what a turn signal on that token reports back. */
  mintHookToken?: (remote: string, sessionId: string) => string | null
  revokeHookToken?: (token: string) => void
  /** Force-resume if a turn never ends (Stop is not guaranteed on interrupt).
   *  Default 600000 (10 min). */
  turnSafetyMs?: number
  /** Cap on holding a new session's paste when the listing never sights it.
   *  Default `PASTE_BACKSTOP_MS`. */
  pasteBackstopMs?: number
  /** Records what a turn changed, as a commit range (D88). Keyed by vault ROOT
   *  rather than by remote: the caller already holds the vault it verified, and
   *  a second remote-to-root lookup could resolve to a different one. Absent in
   *  tests that do not care, and absent means no recording rather than a broken
   *  one. */
  turnLogFor?: (vaultRoot: string) => TurnLog
  /** Claude Code's own session listing (D100), joined to these sessions by pid.
   *  Absent leaves every session's state to the hook bracket alone, which is the
   *  floor this join sits on rather than a fallback bolted beside it. */
  sessionRegistry?: SessionRegistry
  /** Find-only typst path for the child's `$TYPST_BIN` (the md-to-pdf skill).
   *  No download — the resolver only looks. Null when typst isn't installed. */
  resolveTypstBin?: () => Promise<string | null>
  /** Fire-and-forget: cache typst for next time if the machine has never
   *  rendered. Never awaited — the download must not block the spawn path. */
  warmTypst?: () => void
  /** The live Google ops-channel port/token and the generated `holi-google`
   *  path (D67). Read per-spawn like the hook server, since the channel
   *  outlives any one session. The child gets a door, never a token. */
  googlePort?: () => number | null
  /**
   * Mint the Google bearer for **this vault, this session** (D87), and revoke it
   * on teardown.
   *
   * Not a getter, deliberately: a getter answers for whatever vault is active
   * *now*, and an agent session outlives a vault switch — it keeps running
   * against its original vault's cwd while Holi shows another. A bearer that
   * drifted with the screen would have a backgrounded agent read and write
   * another vault's mail, which is D87's own complaint arriving late.
   */
  mintGoogleToken?: (remote: string) => string | null
  revokeGoogleToken?: (token: string) => void
  googleBin?: () => string | null
  /** The directory holding it, prepended to the child's PATH so the agent can
   *  type the bare name — which is what the send gate matches on (D70). */
  holiBin?: () => string | null
  binDir?: () => string | null
  /** The vault's own Claude Code config directory (D86), handed to the child as
   *  `$CLAUDE_CONFIG_DIR`, plus whether it has been signed into.
   *
   *  Called **per spawn**, not per app launch: the active vault changes while the
   *  app runs, and the theme it stamps tracks a setting the user can flip without
   *  restarting. Omitted (tests, and only tests) → the agent runs on the machine
   *  config and no sign-in notice is printed. */
  resolveConfigDir?: (vault: {
    remote: string
    root: string
  }) => Promise<AgentConfigResolution | null>
  log?: (msg: string) => void
}

export interface AgentManager {
  /** Add a session. Serialised against every other `start`, see `spawnChain`. */
  start(args: {
    vaultId: string
    /** What to call it — Claude Code's own `--name`, normalised into argv. */
    name?: string
    resume?: boolean
    cols?: number
    rows?: number
    /** Seed the interactive session's first turn (the reconcile flow). */
    prompt?: string
    /** Text to put in its input box, unsent, once it is up. Held by the manager
     *  rather than written at spawn: a paste written before Claude Code's TUI
     *  reads stdin goes nowhere. */
    paste?: string
  }): Promise<{ ok: true; id: string }>
  /** Put text in one live session's input box, unsent. Refuses a session that
   *  has ended rather than writing into a PTY nobody is reading. */
  paste(id: string, text: string): { ok: boolean; message?: string }
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  /** End one session and drop it from the list. Unknown ids are a no-op. */
  kill(id: string): Promise<{ ok: true }>
  /** Renderer (re)attach to one session: replayable terminal state, and open
   *  that session's data tap. */
  attach(id: string): Promise<string>
  /** The focus file is the VAULT's, so this takes no session. No-op before a
   *  vault has had one. */
  setFocus(focus: FocusInput): void
  /** Turn bracket from the hook server for one session (UserPromptSubmit → true,
   *  Stop → false). Handed to the coordinator, which owns the vault's pause. */
  setTurnActive(sessionId: string, active: boolean): void
  /** The vault's files changed on disk (wired to the host's snapshot signal).
   *  Re-fingerprints each live session's agent-config files against its own
   *  root and flips its `configStale`. */
  notifyVaultChanged(): Promise<void>
  /** Every session, in the order they were started. */
  sessions(): SessionSummary[]
  dispose(): Promise<void>
}

interface Session {
  id: string
  vaultId: string
  /** The bearers minted for this session, revoked when it ends. */
  googleToken: string | null
  hookToken: string | null
  /** The clone dir the session launched in — the root its config fingerprint is
   *  read from. Held so a vault switch can't point the check at the wrong tree. */
  root: string
  /** The Claude Code config directory it runs on, which is also the directory
   *  its row is listed in. Null when the resolver was absent or failed. */
  configDir: string | null
  runtime: AgentRuntime
  mirror: TerminalMirror
  /** False until a renderer has taken this session's terminal state: PTY output
   *  goes to the mirror only, so nothing is streamed to a window that can't show
   *  it — and nothing arrives twice on attach. */
  attached: boolean
  /** The normalised `--name` Holi passed, or null. Half of `deriveName`. */
  nameAtSpawn: string | null
  /** The row's name at the first listing that saw this session. A later change
   *  to it is what a `/name` looks like from outside. */
  firstSeenName: string | null
  /** The last name derived from a row. Held so a session keeps its label when
   *  the listing stops carrying it — after it exits, or across a read that
   *  failed — rather than flapping back to 'New session'. */
  lastName: string | null
  /**
   * Is its TUI up and reading stdin?
   *
   * False from the spawn until the registry first sights the session, or until
   * the backstop gives up waiting for that. A paste written while this is false
   * goes nowhere, so one is held instead.
   */
  ready: boolean
  /** Asks held until it is. Each is delivered as its own paste, in order: two
   *  asks are two things somebody typed, not one longer one. */
  pendingPastes: string[]
  /** The backstop. Cleared when it becomes ready, or when it dies. */
  readyTimer: ReturnType<typeof setTimeout> | null
  /** A content fingerprint of the agent-config files this session loaded. */
  configBaseline: string | null
  configStale: boolean
  exited: boolean
}

/**
 * A content fingerprint of the launch-loaded agent-config files under `root`.
 * Contents, not mtimes, so an identical rewrite (a no-op autosave, a sync that
 * touches the file) does not read as a change; a missing file is its own state,
 * so creating or deleting one shifts the hash too.
 */
async function fingerprintAgentConfig(root: string): Promise<string> {
  const h = createHash('sha1')
  for (const rel of AGENT_CONFIG_FILES) {
    h.update(rel)
    h.update('\0')
    try {
      h.update(await readFile(join(root, rel)))
    } catch {
      h.update('\0absent')
    }
    h.update('\0')
  }
  return h.digest('hex')
}

/**
 * Which of the two names a row is carrying.
 *
 * The listing gives one `name` field and does not say where it came from, so the
 * caller has to know another way. It knows two things the listing does not: it
 * spawned the session, so it knows whether it passed `--name`; and it has seen
 * the row before, so a name that has since changed can only be a `/name` typed
 * inside the session. Anything else is the cwd placeholder, which is identical
 * across the vault's sessions and therefore not a label.
 */
function deriveName(session: Session, row: SessionRow | undefined): string {
  if (row === undefined || row.name === '') {
    return session.lastName ?? session.nameAtSpawn ?? NEW_SESSION
  }
  // The day the command starts emitting `nameSource`, the inference below stops
  // being needed and this line is the whole answer.
  if (row.nameSource !== undefined) return row.nameSource === 'user' ? row.name : NEW_SESSION
  if (session.nameAtSpawn !== null) return row.name
  if (session.firstSeenName !== null && row.name !== session.firstSeenName) return row.name
  return NEW_SESSION
}

export function createAgentManager(deps: AgentManagerDeps): AgentManager {
  const log = deps.log ?? ((msg: string) => console.log(`[agent] ${msg}`))
  const resolveBin = deps.resolveBin ?? (() => resolveClaudeBin())

  /** Insertion-ordered, which is spawn order, which is tab order. */
  const sessions = new Map<string, Session>()
  /** The latest listing, keyed by pid. Empty until the first read, and empty
   *  for as long as the CLI cannot answer. */
  let rows = new Map<number, SessionRow>()
  /** One watcher per config directory, re-established on each spawn: a vault
   *  that has never run an agent has no `sessions/` to watch until it does. */
  const watchers = new Map<string, () => void>()
  let idleRecheck: ReturnType<typeof setTimeout> | null = null
  /** The last list pushed, so a heartbeat that moves no derived field is not a
   *  render. The rows carry fields that move on their own. */
  let lastPushed = ''

  const send = (channel: string, payload: unknown) => {
    deps.getWindow()?.webContents.send(channel, payload)
  }

  const summarise = (session: Session): SessionSummary => {
    const pid = session.runtime.pid
    const row = pid === null ? undefined : rows.get(pid)
    // In this order, and the hook bracket is the FLOOR: a listing that is
    // missing, slow or too old to answer must still show a live turn as working.
    let state: SessionState = 'idle'
    if (row !== undefined && (row.status === 'waiting' || row.waitingFor !== undefined)) {
      state = 'needs-you'
    } else if (row?.status === 'busy' || row?.status === 'shell') {
      state = 'working'
    } else if (coordinator.working.has(session.id)) {
      state = 'working'
    }
    return {
      id: session.id,
      name: deriveName(session, row),
      state,
      ...(state === 'needs-you' && row?.waitingFor !== undefined
        ? { waitingFor: row.waitingFor }
        : {}),
      configStale: session.configStale,
      exited: session.exited,
    }
  }

  const list = (): SessionSummary[] => [...sessions.values()].map(summarise)

  /** Push only when the derived list actually changed. */
  const pushSessions = () => {
    const next = list()
    const encoded = JSON.stringify(next)
    if (encoded === lastPushed) return
    lastPushed = encoded
    send('agent:sessions', next)
  }

  const coordinator: TurnCoordinator = createTurnCoordinator({
    activeVault: () => deps.host.active(),
    ...(deps.turnLogFor === undefined ? {} : { turnLogFor: deps.turnLogFor }),
    ...(deps.turnSafetyMs === undefined ? {} : { turnSafetyMs: deps.turnSafetyMs }),
    onChange: () => pushSessions(),
    log,
  })

  /**
   * Re-read Claude Code's listing for every directory a live session runs in,
   * and re-derive from it.
   *
   * Never rejects and never blocks anything: the registry answers an empty map
   * for every failure, and the worst case is a card that keeps saying what the
   * hook bracket says.
   */
  async function refreshRows(): Promise<void> {
    const registry = deps.sessionRegistry
    if (registry === undefined) return
    // One read per (directory, root) pair rather than per session: D86 gives a
    // vault one config directory, so its sessions are all in the same listing.
    const groups = new Map<string, { configDir: string; vaultRoot: string }>()
    for (const session of sessions.values()) {
      if (session.exited || session.configDir === null) continue
      groups.set(`${session.configDir}\u0000${session.root}`, {
        configDir: session.configDir,
        vaultRoot: session.root,
      })
    }
    const next = new Map<number, SessionRow>()
    for (const group of groups.values()) {
      for (const [pid, row] of await registry.readRows(group)) next.set(pid, row)
    }
    rows = next

    let wantsRecheck = false
    for (const session of sessions.values()) {
      const pid = session.runtime.pid
      const row = pid === null ? undefined : rows.get(pid)
      if (row === undefined) continue
      // The baseline for the `/name` inference: the name this session was listed
      // under the first time we saw it.
      if (session.firstSeenName === null) {
        session.firstSeenName = row.name
        // …and the first sighting is also what a held paste was waiting for: a
        // session is in this listing because Claude Code wrote its file at
        // `SessionStart`, so its TUI is up and reading.
        markReady(session)
      }
      session.lastName = deriveName(session, row)
      if (row.status !== 'idle') {
        // Whatever it is doing, it is not between turns. That cancels any idle
        // candidacy, which is what makes the confirmation two CONSECUTIVE
        // readings rather than any two a whole turn apart.
        coordinator.noteBusy(session.id)
        continue
      }
      // Claude Code says this session has no turn. The coordinator wants that
      // confirmed by a second reading, and a quiet session produces no watcher
      // edge, so the second reading has to be asked for.
      if (!coordinator.working.has(session.id)) continue
      coordinator.noteIdle(session.id)
      // Still mid-turn: that was the first of the two readings, so ask for the
      // second. One session wanting it is enough for all of them.
      if (coordinator.working.has(session.id)) wantsRecheck = true
    }
    if (wantsRecheck && idleRecheck === null) {
      idleRecheck = setTimeout(() => {
        idleRecheck = null
        void refreshRows()
      }, IDLE_RECHECK_MS)
    }
    pushSessions()
  }

  /** Watch a config directory's session state, replacing any earlier watch on
   *  it — the directory may not have existed when we last tried. */
  function watchConfigDir(configDir: string): void {
    const registry = deps.sessionRegistry
    if (registry === undefined) return
    watchers.get(configDir)?.()
    watchers.set(
      configDir,
      registry.watch(configDir, () => {
        void refreshRows()
      }),
    )
  }

  /**
   * The focus file is one path in the clone, so it has one writer per VAULT.
   * N sessions writing the same line would be N debounced writers racing to say
   * the same thing.
   */
  let focusWriter: { root: string; snapshot: ContextSnapshot } | null = null
  function ensureFocusWriter(workRoot: string): void {
    if (focusWriter?.root === workRoot) return
    focusWriter?.snapshot.stop()
    focusWriter = { root: workRoot, snapshot: new ContextSnapshot({ workRoot }) }
  }

  /**
   * This session's TUI is up: deliver whatever was held for it.
   *
   * Called on its first sighting in the listing and by the backstop, and it is
   * one-shot — `ready` latches, so a second sighting has nothing left to do and
   * every later paste goes straight through.
   */
  function markReady(session: Session): void {
    if (session.readyTimer !== null) {
      clearTimeout(session.readyTimer)
      session.readyTimer = null
    }
    if (session.ready) return
    session.ready = true
    const held = session.pendingPastes.splice(0)
    if (session.exited) return
    for (const text of held) session.runtime.write(bracketedPaste(text))
  }

  /** It is never going to be read now. */
  function dropPending(session: Session): void {
    if (session.readyTimer !== null) {
      clearTimeout(session.readyTimer)
      session.readyTimer = null
    }
    session.pendingPastes.length = 0
  }

  /**
   * End one session: stop its PTY, hand back its bearers, and drop it.
   *
   * The coordinator hears about it first, so a session that died mid-turn leaves
   * the working set at once rather than holding the vault paused behind a
   * process that is gone.
   */
  async function teardown(session: Session): Promise<void> {
    if (!sessions.delete(session.id)) return // guard the double-stop
    coordinator.forget(session.id)
    dropPending(session)
    // Before anything else mints its own: a dead session's bearer must stop
    // opening the door.
    if (session.googleToken !== null) deps.revokeGoogleToken?.(session.googleToken)
    if (session.hookToken !== null) deps.revokeHookToken?.(session.hookToken)
    await session.runtime.kill()
    session.mirror.dispose()
    // The last session out takes the focus writer with it, the way the vault's
    // pause goes with the last turn.
    if (sessions.size === 0) {
      focusWriter?.snapshot.stop()
      focusWriter = null
      for (const unwatch of watchers.values()) unwatch()
      watchers.clear()
      if (idleRecheck !== null) {
        clearTimeout(idleRecheck)
        idleRecheck = null
      }
      rows = new Map()
    }
  }

  /**
   * Spawns are serialised, one chain for the whole manager.
   *
   * Two concurrent ones race two unlocked read-modify-writes inside
   * `ensureAgentConfigDir` — `settings.json` (`agent-config-dir.ts:143-146`) and
   * the stat-then-write `takeFirstSpawn` (`:172-177`) — which loses one session's
   * settings and prints the sign-in notice twice.
   */
  let spawnChain: Promise<unknown> = Promise.resolve()

  async function spawn(args: {
    vaultId: string
    name?: string
    resume?: boolean
    cols?: number
    rows?: number
    prompt?: string
    paste?: string
  }): Promise<{ ok: true; id: string }> {
    const vault = deps.host.active()
    if (!vault || vault.remote !== args.vaultId) {
      throw new Error('vault is not active — open it first')
    }

    const bin = resolveBin()
    if (!bin) {
      throw new Error(
        'Claude CLI not found on PATH — install it (https://claude.com/claude-code) and restart Holi',
      )
    }

    const id = randomUUID()
    const workRoot = vault.root
    // Find-only ($TYPST_BIN for the md-to-pdf skill) — a fast `which`, never a
    // download. Then warm the cache fire-and-forget so a machine that has never
    // rendered has typst next time; the download must never block this spawn.
    const typstBin = (await deps.resolveTypstBin?.()) ?? null
    deps.warmTypst?.()
    const googleToken = deps.mintGoogleToken?.(vault.remote) ?? null
    const hookToken = deps.mintHookToken?.(vault.remote, id) ?? null
    // The vault's own config directory (D86), resolved here rather than at launch
    // because the active vault moves under this manager. A failure must not cost
    // the user their agent — the same treatment `resolveTypstBin` gets.
    const config = await (
      deps.resolveConfigDir?.({ remote: vault.remote, root: workRoot }) ?? Promise.resolve(null)
    ).catch((err: unknown) => {
      log(`config directory unresolved, running on the machine config: ${String(err)}`)
      return null
    })
    // Born at the caller's geometry: the mirror and the PTY share it, so the
    // replayed state and Claude's own TUI both match the pane.
    const terminal = new TerminalMirror(args.cols ?? 80, args.rows ?? 24)
    // Into the MIRROR only, and before the PTY writes a byte, so the instruction
    // sits above Claude's own output rather than under an Ink redraw. Nothing is
    // attached to this session yet; the renderer takes this line from its
    // `attach()` replay, once. Spawns being serialised is what keeps this to the
    // first session in a fresh directory rather than to all of them.
    if (config?.firstSpawn) terminal.write(SIGN_IN_NOTICE)
    const runtime = new AgentRuntime({
      spawnPty: deps.spawnPty,
      killGraceMs: deps.killGraceMs,
      killBackstopMs: deps.killBackstopMs,
    })
    const session: Session = {
      id,
      vaultId: args.vaultId,
      googleToken,
      hookToken,
      root: workRoot,
      configDir: config?.dir ?? null,
      runtime,
      mirror: terminal,
      attached: false,
      nameAtSpawn: sessionName(args.name),
      firstSeenName: null,
      lastName: null,
      ready: false,
      pendingPastes: args.paste !== undefined && args.paste !== '' ? [args.paste] : [],
      readyTimer: null,
      configBaseline: null,
      configStale: false,
      exited: false,
    }
    runtime.onData((data) => {
      terminal.write(data) // the mirror is the record; the renderer is a view
      if (session.attached) send('agent-pty:data', { id, data })
    })
    runtime.onExit((e) => {
      log(`session ${id} exited (code ${e.exitCode})`)
      // The session stays in the list with its scrollback: an exit is something
      // to read, not a tab that disappears from under the reader. It leaves the
      // working set at once, though — nothing is going to end that turn now.
      session.exited = true
      session.attached = false
      coordinator.forget(id)
      dropPending(session)
      if (session.googleToken !== null) deps.revokeGoogleToken?.(session.googleToken)
      if (session.hookToken !== null) deps.revokeHookToken?.(session.hookToken)
      session.googleToken = null
      session.hookToken = null
      send('agent-pty:exit', { id, code: e.exitCode })
      pushSessions()
    })

    try {
      runtime.start({
        bin,
        // No systemPrompt; `prompt` seeds the reconcile turn, `name` is Claude
        // Code's own session name and the one the tabs read back.
        args: buildAgentArgs({
          ...(args.name === undefined ? {} : { name: args.name }),
          ...(args.resume === undefined ? {} : { resume: args.resume }),
          ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
        }),
        cwd: workRoot,
        env: buildAgentEnv(process.env, {
          hookPort: deps.hookPort?.() ?? null,
          hookToken,
          typstBin,
          googlePort: deps.googlePort?.() ?? null,
          googleToken,
          googleBin: deps.googleBin?.() ?? null,
          holiBin: deps.holiBin?.() ?? null,
          binDir: deps.binDir?.() ?? null,
          configDir: config?.dir ?? null,
        }),
        ...(args.cols === undefined ? {} : { cols: args.cols }),
        ...(args.rows === undefined ? {} : { rows: args.rows }),
      })
    } catch (err) {
      if (googleToken !== null) deps.revokeGoogleToken?.(googleToken)
      if (hookToken !== null) deps.revokeHookToken?.(hookToken)
      terminal.dispose()
      throw err
    }

    sessions.set(id, session)
    // Armed only once the PTY is alive: a spawn that threw has nothing to paste
    // into, and its `catch` above has already torn the mirror down. Armed whether
    // or not anything is held, because it is what bounds how long the NEXT ask
    // waits on a listing that may never answer.
    session.readyTimer = setTimeout(
      () => markReady(session),
      deps.pasteBackstopMs ?? PASTE_BACKSTOP_MS,
    )
    // After the spawn took, so a failed one cannot retire a writer that another
    // vault's sessions are still using.
    ensureFocusWriter(workRoot)
    // Baseline the config the child just loaded, so a later change reads as stale.
    session.configBaseline = await fingerprintAgentConfig(workRoot)
    // The directory exists now even if it did not a moment ago, so this is where
    // a watch that failed for a never-used vault finally takes.
    if (session.configDir !== null) watchConfigDir(session.configDir)
    pushSessions()
    void refreshRows()
    return { ok: true, id }
  }

  /**
   * A vault file changed on disk (wired to the host's snapshot signal). Re-check
   * each live session's config fingerprint against **its own root**; if a synced
   * agent-config file moved since that session launched, it is running stale
   * until it restarts. Cheap and skipped once already stale (sticky).
   */
  async function notifyVaultChanged(): Promise<void> {
    const candidates = [...sessions.values()].filter(
      (s) => !s.exited && !s.configStale && s.configBaseline !== null,
    )
    if (candidates.length === 0) return
    // One read per distinct root, not per session: they are usually all the same
    // vault, and the fingerprint is a handful of small file reads.
    const prints = new Map<string, string>()
    for (const root of new Set(candidates.map((s) => s.root))) {
      prints.set(root, await fingerprintAgentConfig(root))
    }
    let changed = false
    for (const session of candidates) {
      // A session may have died during the await; only a still-live, still-fresh
      // one flips.
      if (!sessions.has(session.id) || session.exited || session.configStale) continue
      if (prints.get(session.root) !== session.configBaseline) {
        session.configStale = true
        changed = true
      }
    }
    if (changed) pushSessions()
  }

  return {
    start(args) {
      // Every start queues behind every other one, failures included: the chain
      // is about the config directory's unlocked writes, not about success.
      const run = spawnChain.then(
        () => spawn(args),
        () => spawn(args),
      )
      spawnChain = run.catch(() => {})
      return run
    },

    /**
     * A renderer is taking over one session's terminal. Serialize BEFORE opening
     * the tap: a chunk that lands mid-serialize goes to the mirror only and
     * repaints on the next output — it is never both replayed and streamed.
     */
    async attach(id) {
      const session = sessions.get(id)
      if (session === undefined) return ''
      // The drawer is opening on this session, which is one of the moments the
      // design says to re-read the listing: a watcher edge is not guaranteed to
      // have fired since anything last looked.
      void refreshRows()
      const state = await session.mirror.serialize()
      if (!session.exited) session.attached = true
      return state
    },

    /**
     * A session that has gone is a refusal, not a silent drop: the text is in a
     * box the user typed it into, and the honest answer is to leave it there and
     * say why.
     *
     * One that simply is not up yet is neither. It is a real session, it is in
     * the drawer, it is the tab an ask defaults to from the moment it appears —
     * and a paste written into it before its TUI reads stdin would be accepted
     * here and land nowhere. So it joins the queue the spawn's own paste is
     * already in.
     */
    paste: (id, text) => {
      const session = sessions.get(id)
      if (session === undefined || session.exited) {
        return { ok: false, message: 'That session has ended. Pick another one.' }
      }
      if (!session.ready) session.pendingPastes.push(text)
      else session.runtime.write(bracketedPaste(text))
      return { ok: true }
    },

    write: (id, data) => sessions.get(id)?.runtime.write(data),

    resize: (id, cols, rows) => {
      const session = sessions.get(id)
      if (session === undefined) return
      session.runtime.resize(cols, rows)
      session.mirror.resize(cols, rows) // the record reflows with the view
    },

    kill: async (id) => {
      const session = sessions.get(id)
      if (session !== undefined) await teardown(session)
      pushSessions()
      return { ok: true }
    },

    // The focus file is the vault's, so this takes no session and does not wait
    // for one: focus set before the first spawn is focus the first turn should
    // still see. No vault open is the only case that no-ops.
    setFocus: (focus) => {
      const vault = deps.host.active()
      if (vault === null) return
      ensureFocusWriter(vault.root)
      focusWriter?.snapshot.setFocus(focus)
    },

    setTurnActive: (sessionId, active) => {
      // A stray or late hook must not pause a vault on behalf of a session that
      // is gone — the token is revoked with the session, so this is belt only.
      if (!sessions.has(sessionId)) return
      if (active) coordinator.begin(sessionId)
      else coordinator.end(sessionId)
      // A turn boundary moves every derived field, and it is a moment Holi knows
      // about without waiting for a watcher edge.
      void refreshRows()
    },

    notifyVaultChanged,
    sessions: list,

    dispose: async () => {
      for (const session of [...sessions.values()]) await teardown(session)
    },
  }
}
