/**
 * Session orchestration: owns the one live `claude` session — its PTY, its
 * terminal mirror, and the focus file the per-turn hook reads — and ties it to
 * the active vault.
 *
 * Pure Claude Code (prd/agent.md): no MCP surface, no built system prompt, no
 * turn protocol, no presence. The agent's whole surface is its native tools on
 * the vault's files; Holi's only per-turn injection is the focused-note line,
 * written by the focus writer. The vault coupling is a single `VaultHost.active()`
 * read — the clone dir is the cwd, and its being a real git repo is why the
 * agent can run git against it directly.
 *
 * NOTE: no runtime `electron` import (types only). The window arrives through
 * `getWindow()`, so this module loads under vitest.
 */
import type { BrowserWindow } from 'electron'
import type { VaultHost } from '../vault/active-vault'
import {
  AgentRuntime,
  buildAgentArgs,
  buildAgentEnv,
  isClaudeAuthenticated,
  resolveClaudeBin,
  type SpawnPty,
} from './agent-runtime'
import { ContextSnapshot, type FocusInput } from './context-snapshot'
import { TerminalMirror } from './terminal-mirror'

export interface AgentStatus {
  running: boolean
  /** A turn is open — Claude is mid-turn. Driven by the hook server's turn
   *  bracket (UserPromptSubmit → true, Stop → false), NOT by parsing PTY output. */
  working: boolean
  /** Synced agent config changed under a live session. Its D60 detection source
   *  was deleted; a "restart to pick up config" nudge is a PRD open question, so
   *  false for now. */
  configStale: boolean
  authenticated: boolean
}

export interface AgentManagerDeps {
  host: VaultHost
  getWindow(): BrowserWindow | null
  spawnPty?: SpawnPty
  resolveBin?: () => string | null
  killGraceMs?: number
  /** The live hook-server port/token, injected into the child so its seeded
   *  curl hooks can reach us. Read per-spawn (the server outlives sessions). */
  hookPort?: () => number | null
  hookToken?: () => string | null
  /** Force-resume if a turn never ends (Stop is not guaranteed on interrupt).
   *  Default 600000 (10 min). */
  turnSafetyMs?: number
  log?: (msg: string) => void
}

export interface AgentManager {
  start(args: { vaultId: string; resume?: boolean; cols?: number; rows?: number }): Promise<{ ok: true }>
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): Promise<{ ok: true }>
  /** Renderer (re)attach: replayable terminal state, and open the data tap. */
  attach(): Promise<string>
  setFocus(focus: FocusInput): void
  /** Turn bracket from the hook server: true on UserPromptSubmit, false on Stop.
   *  Drives the vault pause/resume and status().working. No-op with no session. */
  setTurnActive(active: boolean): void
  status(): AgentStatus
  dispose(): Promise<void>
}

interface Session {
  vaultId: string
  runtime: AgentRuntime
  mirror: TerminalMirror
  snapshot: ContextSnapshot
}

export function createAgentManager(deps: AgentManagerDeps): AgentManager {
  const log = deps.log ?? ((msg: string) => console.log(`[agent] ${msg}`))
  const resolveBin = deps.resolveBin ?? (() => resolveClaudeBin())

  let session: Session | null = null
  /** False until a renderer has taken the terminal state: PTY output goes to
   * the mirror only, so nothing is streamed to a window that can't show it —
   * and nothing arrives twice on attach. */
  let attached = false

  const turnSafetyMs = deps.turnSafetyMs ?? 600_000
  let working = false
  let safetyTimer: ReturnType<typeof setTimeout> | null = null
  const clearSafety = () => {
    if (safetyTimer) {
      clearTimeout(safetyTimer)
      safetyTimer = null
    }
  }

  const send = (channel: string, payload: unknown) => {
    deps.getWindow()?.webContents.send(channel, payload)
  }

  const status = (): AgentStatus => ({
    running: session !== null,
    working,
    configStale: false,
    authenticated: isClaudeAuthenticated(),
  })

  const pushStatus = () => send('agent:status', status())

  /**
   * Turn bracket from the hook server (UserPromptSubmit → true, Stop → false).
   * Suspends the vault's sync loop for the turn so the two git actors never
   * contend on `.git/index.lock`, and resumes it (a catch-up commit + pull) when
   * the turn ends. This is the hook-driven signal that replaced slice 2's
   * reverted PTY-activity heuristic — see the git-coexistence plan.
   */
  function setTurnActive(active: boolean): void {
    if (session === null) return // a stray/late hook must not pause an agent-less vault
    if (active === working) return
    working = active
    if (active) {
      deps.host.active()?.pause('the assistant is working')
      // Stop is not guaranteed (interrupt/crash) — cap the pause so a turn that
      // never signals its end can't strand the vault paused.
      clearSafety()
      safetyTimer = setTimeout(() => setTurnActive(false), turnSafetyMs)
    } else {
      clearSafety()
      deps.host.active()?.resume()
    }
    pushStatus()
  }

  async function teardown(): Promise<void> {
    const current = session
    if (!current) return
    session = null // guard the double-stop: the PTY exit path tears down too
    attached = false
    clearSafety()
    if (working) {
      working = false
      deps.host.active()?.resume() // never leave the vault paused behind a dead session
    }
    current.snapshot.stop()
    await current.runtime.kill()
    current.mirror.dispose()
  }

  async function start({
    vaultId,
    resume,
    cols,
    rows,
  }: {
    vaultId: string
    resume?: boolean
    /** The drawer's fitted geometry. Absent (e.g. a reconcile-seeded start with
     *  no renderer) → node-pty and xterm use their own native 80×24. */
    cols?: number
    rows?: number
  }): Promise<{ ok: true }> {
    const vault = deps.host.active()
    if (!vault || vault.remote !== vaultId) {
      throw new Error('vault is not active — open it first')
    }

    await teardown() // restart semantics: one session at a time

    const bin = resolveBin()
    if (!bin) {
      throw new Error('Claude CLI not found on PATH — install it (https://claude.com/claude-code) and restart Holi')
    }

    const workRoot = vault.root
    // Born at the caller's geometry: the mirror and the PTY share it, so the
    // replayed state and Claude's own TUI both match the pane.
    const terminal = new TerminalMirror(cols, rows)
    const snapshot = new ContextSnapshot({ workRoot })
    const runtime = new AgentRuntime({ spawnPty: deps.spawnPty, killGraceMs: deps.killGraceMs })
    runtime.onData((data) => {
      terminal.write(data) // the mirror is the record; the renderer is a view
      if (attached) send('agent-pty:data', data)
    })
    runtime.onExit((e) => {
      log(`session exited (code ${e.exitCode})`)
      send('agent-pty:exit', { code: e.exitCode })
      void teardown().then(pushStatus)
    })

    try {
      runtime.start({
        bin,
        args: buildAgentArgs({ resume }), // no systemPrompt — pure Claude Code
        cwd: workRoot,
        env: buildAgentEnv(process.env, {
          hookPort: deps.hookPort?.() ?? null,
          hookToken: deps.hookToken?.() ?? null,
        }),
        cols,
        rows,
      })
    } catch (err) {
      snapshot.stop()
      terminal.dispose()
      throw err
    }

    session = { vaultId, runtime, mirror: terminal, snapshot }
    pushStatus()
    return { ok: true }
  }

  /**
   * A renderer is taking over the terminal. Serialize BEFORE opening the tap:
   * a chunk that lands mid-serialize goes to the mirror only and repaints on
   * the next output — it is never both replayed and streamed.
   */
  async function attach(): Promise<string> {
    if (!session) return ''
    const state = await session.mirror.serialize()
    attached = true
    return state
  }

  return {
    start,
    attach,
    write: (data) => session?.runtime.write(data),
    resize: (cols, rows) => {
      if (!session) return
      session.runtime.resize(cols, rows)
      session.mirror.resize(cols, rows) // the record reflows with the view
    },
    kill: async () => {
      await teardown()
      pushStatus()
      return { ok: true }
    },
    // Focus is session-bound: the hook only matters while a session runs, and the
    // writer targets the session's clone. Before a session starts this no-ops.
    setFocus: (focus) => session?.snapshot.setFocus(focus),
    setTurnActive,
    status,
    dispose: async () => {
      await teardown()
    },
  }
}
