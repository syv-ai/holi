/**
 * The vault's assistant, as Claude Code runs it (D110).
 *
 * **A session is Claude Code's background session.** Its supervisor runs it,
 * its short job id names it, and it outlives any window onto it. Holi does not
 * spawn conversations; it asks Claude Code to (`claude --bg`), opens terminals
 * onto them (`agent-terminals.ts`), and reads what they are doing
 * (`claude-sessions.ts`). This module ties those to the active vault.
 *
 * Three things belong to the **vault**, not to any session, and live here: the
 * config directory with its endpoint file (D86, D110), the sync pause (owned by
 * the turn coordinator), and the focus file the per-turn hook reads.
 *
 * **Holi does not decide what a session is doing.** Claude Code's listing says
 * so; the hook bracket stays as the floor under it, because a slow or missing
 * CLI must still report a live turn, and the sync pause has a deadline a
 * watcher cannot meet.
 *
 * NOTE: no runtime `electron` import (types only), so this loads under vitest.
 */
import type { BrowserWindow } from 'electron'
import type { VaultHost } from '../vault/active-vault'
import type { AgentTerminals } from './agent-terminals'
import { sessionName, type ClaudeCli, type VaultCliTarget } from './claude-cli'
import {
  isLive,
  parseListing,
  summarise,
  watchConfigDir,
  type ClaudeRow,
  type SessionSummary,
} from './claude-sessions'
import { ContextSnapshot, type FocusInput } from './context-snapshot'
import { createTurnCoordinator, type TurnCoordinator } from './turn-coordinator'
import type { TurnLog } from './turn-log'

/**
 * Printed into the first terminal Holi opens on a fresh config directory (D86).
 * Credentials are keyed to the directory, so one Holi has never used cannot be
 * signed in. In the scrollback, because `/login` fires nothing Holi sees.
 */
export const SIGN_IN_NOTICE =
  '\x1b[33mThis vault needs its own Claude sign-in. Type /login below.\r\n' +
  'Each vault keeps its own Claude Code config, so signing in here\r\n' +
  'does not touch your other vaults.\x1b[0m\r\n\r\n'

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

export interface VaultRef {
  remote: string
  root: string
}

export interface AgentSessionsDeps {
  host: Pick<VaultHost, 'active'>
  getWindow(): BrowserWindow | null
  cli: ClaudeCli
  terminals: AgentTerminals
  /** Provision the vault's config directory (D86) and say whether Holi has
   *  ever used it. Null leaves the vault without an assistant. */
  resolveConfig(vault: VaultRef): Promise<{ dir: string; firstSpawn: boolean } | null>
  /** Holi's generated commands, first on every session's `PATH`. */
  binDir(): string | null
  /** Write the vault's `holi.env`: where its sessions find this Holi. */
  claimEndpoint(vault: VaultRef & { configDir: string }): Promise<void>
  /** Holi is leaving the vault: delete `holi.env` and revoke what it held. */
  releaseEndpoint(vault: VaultRef & { configDir: string }): Promise<void>
  /** Injected so tests need no filesystem. */
  watch?: (configDir: string, onChange: () => void) => () => void
  turnLogFor?: (vaultRoot: string) => TurnLog
  turnSafetyMs?: number
  idleRecheckMs?: number
  /** Forwarded to the turn coordinator. */
  idleConfirmMs?: number
  leaveCapMs?: number
  log?: (msg: string) => void
}

export interface AgentSessions {
  /** Make sure Holi is attached to the active vault's sessions. Cheap when it
   *  already is; call it whenever a vault may have opened. */
  ensure(): Promise<void>
  /** The vault's live sessions, in listing order. */
  sessions(): SessionSummary[]
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
  stop(id: string): Promise<ActionResult>
  respawn(id: string): Promise<ActionResult>
  duplicate(id: string, geometry?: Geometry): Promise<StartResult>
  /** A turn edge from the seeded hook, by vault and job id. */
  noteTurn(remote: string, jobId: string, active: boolean): void
  /** The focus file is the vault's, so this names no session. */
  setFocus(focus: FocusInput): void
  /** Let go of the vault: optionally stop its live sessions, close every
   *  terminal, release the endpoint. Bounded; never rejects. */
  leave(opts?: { stopSessions?: boolean }): Promise<void>
}

interface Current {
  remote: string
  root: string
  configDir: string
  /** Consumed by the first terminal opened on this directory. */
  firstSpawn: boolean
  unwatch: () => void
  /** False until the first listing read, which seeds the working set. */
  seeded: boolean
}

export function createAgentSessions(deps: AgentSessionsDeps): AgentSessions {
  const log = deps.log ?? ((msg: string) => console.log(`[agent] ${msg}`))
  const watch = deps.watch ?? ((dir: string, cb: () => void) => watchConfigDir(dir, cb, log))
  let current: Current | null = null
  let activating: Promise<Current | null> | null = null
  /** The latest listing for the current vault, live or not. */
  let rows: ClaudeRow[] = []
  let lastPushed = ''
  let idleRecheck: ReturnType<typeof setTimeout> | null = null
  let focusWriter: { root: string; snapshot: ContextSnapshot } | null = null

  const send = (channel: string, payload: unknown): void => {
    deps.getWindow()?.webContents.send(channel, payload)
  }

  const coordinator: TurnCoordinator = createTurnCoordinator({
    activeVault: () => deps.host.active(),
    ...(deps.turnLogFor === undefined ? {} : { turnLogFor: deps.turnLogFor }),
    ...(deps.turnSafetyMs === undefined ? {} : { turnSafetyMs: deps.turnSafetyMs }),
    ...(deps.idleConfirmMs === undefined ? {} : { idleConfirmMs: deps.idleConfirmMs }),
    onChange: () => push(),
    log,
  })

  const live = (): ClaudeRow[] => rows.filter(isLive)
  const summaries = (): SessionSummary[] => live().map((row) => summarise(row, coordinator.working))

  function push(): void {
    const next = summaries()
    const encoded = JSON.stringify(next)
    if (encoded === lastPushed) return
    lastPushed = encoded
    send('agent:sessions', next)
  }

  const targetOf = (c: Current): VaultCliTarget => ({
    root: c.root,
    configDir: c.configDir,
    binDir: deps.binDir(),
  })

  async function activate(vault: VaultRef): Promise<Current | null> {
    const config = await deps.resolveConfig(vault).catch((err: unknown) => {
      log(`config directory unresolved: ${String(err)}`)
      return null
    })
    if (config === null) return null
    await deps
      .claimEndpoint({ ...vault, configDir: config.dir })
      .catch((err: unknown) => log(`endpoint not written: ${String(err)}`))
    const next: Current = {
      remote: vault.remote,
      root: vault.root,
      configDir: config.dir,
      firstSpawn: config.firstSpawn,
      unwatch: () => {},
      seeded: false,
    }
    next.unwatch = watch(config.dir, () => void refresh())
    return next
  }

  async function ensureCurrent(): Promise<Current | null> {
    const vault = deps.host.active()
    if (vault === null) return null
    if (current?.remote === vault.remote) return current
    if (activating !== null) return activating
    // A different vault without a `leave` in between: let go of the old one's
    // watch and endpoint, but its sessions are not ours to stop from here.
    if (current !== null) await release(current)
    activating = activate({ remote: vault.remote, root: vault.root })
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
    const stdout = await deps.cli.list(targetOf(c))
    if (current !== c) return // the vault moved while we read
    rows = parseListing(stdout, c.root)
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

    let wantsRecheck = false
    for (const row of liveRows) {
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
    await deps
      .releaseEndpoint({ remote: c.remote, root: c.root, configDir: c.configDir })
      .catch((err: unknown) => log(`endpoint not released: ${String(err)}`))
  }

  async function openOn(c: Current, args: Geometry & { attach?: string }): Promise<OpenResult> {
    const notice = c.firstSpawn ? SIGN_IN_NOTICE : undefined
    c.firstSpawn = false
    const res = deps.terminals.open({
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
    async ensure() {
      await ensureCurrent()
    },

    sessions: summaries,
    refresh,

    async open(args) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      return openOn(c, args)
    },

    async start({ name, prompt, cols, rows: r }) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      const res = await deps.cli.startBg(targetOf(c), {
        ...(name === undefined ? {} : { name }),
        ...(prompt === undefined ? {} : { prompt }),
      })
      if (!res.ok) return res
      await refresh()
      const opened = await openOn(c, { attach: res.id, cols, rows: r })
      return opened.ok ? { ok: true, sessionId: res.id, terminalId: opened.terminalId } : opened
    },

    async send({ text, target, cols, rows: r }) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      let terminalId: string
      if (target === 'new') {
        const started = await api.start({ name: sessionName(text) ?? undefined, cols, rows: r })
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
      const res = await deps.cli.stop(targetOf(c), id)
      await refresh()
      return res
    },

    async respawn(id) {
      const c = await ensureCurrent()
      if (c === null) return noVault
      const res = await deps.cli.respawn(targetOf(c), id)
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
      const label = summarise(row, coordinator.working).name
      const name = label === 'New session' ? undefined : `${label} (copy)`
      const res = await deps.cli.forkBg(targetOf(c), row.sessionId, name)
      if (!res.ok) return res
      await refresh()
      const opened = await openOn(c, { attach: res.id, ...geometry })
      return opened.ok ? { ok: true, sessionId: res.id, terminalId: opened.terminalId } : opened
    },

    noteTurn(remote, jobId, active) {
      // A turn in a vault Holi is not showing is not this vault's pause.
      if (current?.remote !== remote) return
      if (active) coordinator.begin(jobId)
      else coordinator.end(jobId)
      void refresh()
    },

    setFocus(focus) {
      const vault = deps.host.active()
      if (vault === null) return
      if (focusWriter?.root !== vault.root) {
        focusWriter?.snapshot.stop()
        focusWriter = { root: vault.root, snapshot: new ContextSnapshot({ workRoot: vault.root }) }
      }
      focusWriter.snapshot.setFocus(focus)
    },

    async leave({ stopSessions = true } = {}) {
      const c = current
      if (c === null) return
      if (stopSessions) {
        const stops = Promise.all(live().map((row) => deps.cli.stop(targetOf(c), row.id)))
        await Promise.race([
          stops,
          new Promise((r) => setTimeout(r, deps.leaveCapMs ?? LEAVE_CAP_MS)),
        ])
      }
      await deps.terminals.closeAll()
      for (const id of [...coordinator.working]) coordinator.forget(id)
      if (idleRecheck !== null) {
        clearTimeout(idleRecheck)
        idleRecheck = null
      }
      focusWriter?.snapshot.stop()
      focusWriter = null
      current = null
      rows = []
      await release(c)
      push()
    },
  }
  return api
}
