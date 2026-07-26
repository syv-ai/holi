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

/** The panel fits and resizes immediately after start; this is just the seed. */
const SPAWN_COLS = 80
const SPAWN_ROWS = 24

export interface AgentStatus {
  running: boolean
  /** A turn is open — Claude is mid-edit. Wired from PTY activity in slice 2
   *  (git coexistence); false for now. */
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
  log?: (msg: string) => void
}

export interface AgentManager {
  start(args: { vaultId: string; resume?: boolean }): Promise<{ ok: true }>
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): Promise<{ ok: true }>
  /** Renderer (re)attach: replayable terminal state, and open the data tap. */
  attach(): Promise<string>
  setFocus(focus: FocusInput): void
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

  const send = (channel: string, payload: unknown) => {
    deps.getWindow()?.webContents.send(channel, payload)
  }

  const status = (): AgentStatus => ({
    running: session !== null,
    working: false,
    configStale: false,
    authenticated: isClaudeAuthenticated(),
  })

  const pushStatus = () => send('agent:status', status())

  async function teardown(): Promise<void> {
    const current = session
    if (!current) return
    session = null // guard the double-stop: the PTY exit path tears down too
    attached = false
    current.snapshot.stop()
    await current.runtime.kill()
    current.mirror.dispose()
  }

  async function start({ vaultId, resume }: { vaultId: string; resume?: boolean }): Promise<{ ok: true }> {
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
    const terminal = new TerminalMirror(SPAWN_COLS, SPAWN_ROWS)
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
        env: buildAgentEnv(process.env),
        cols: SPAWN_COLS,
        rows: SPAWN_ROWS,
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
    status,
    dispose: async () => {
      await teardown()
    },
  }
}
