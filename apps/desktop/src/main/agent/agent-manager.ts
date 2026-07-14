/**
 * Session orchestration (spec §AgentRuntime + §McpServer): owns the one live
 * `claude` session — its PTY, its MCP server, its context snapshot — and keeps
 * it tied to the active vault by observing the VaultManager.
 *
 * NOTE: no runtime `electron` import (types only). The window arrives through
 * `getWindow()`, so this module loads under vitest.
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { Task } from '@holi/shared'
import type { ServerClient } from '../server-client'
import { toVaultRel } from '../vault/vault-files'
import type { VaultMirror } from '../vault/vault-mirror'
import type { TasksEvent, VaultManager, VaultObserver } from '../vault/vault-manager'
import {
  AgentRuntime,
  buildAgentArgs,
  buildAgentEnv,
  isClaudeAuthenticated,
  resolveClaudeBin,
  type SpawnPty,
} from './agent-runtime'
import { ContextSnapshot } from './context-snapshot'
import { buildOps } from './mcp-ops'
import { McpServer } from './mcp-server'
import { buildSystemPrompt, readVaultTree } from './system-prompt'
import { TerminalMirror } from './terminal-mirror'

/** Agent config the whole vault shares — a synced change to any of it means the
 * running session is working from a stale prompt/hook set. */
const CONFIG_PATHS = ['.claude/', 'CLAUDE.md', 'AGENTS.md']

/** Let the last write's watcher event land before we merge the turn. */
const DEFAULT_SETTLE_MS = 300

/** The panel fits and resizes immediately after start; this is just the seed. */
const SPAWN_COLS = 80
const SPAWN_ROWS = 24

export interface AgentStatus {
  running: boolean
  working: boolean
  configStale: boolean
  authenticated: boolean
}

export interface AgentManagerDeps {
  client: ServerClient
  vaultManager: VaultManager
  getWindow(): BrowserWindow | null
  spawnPty?: SpawnPty
  resolveBin?: () => string | null
  settleMs?: number
  killGraceMs?: number
  log?: (msg: string) => void
}

export interface AgentManager {
  observer: VaultObserver
  start(args: { vaultId: string; resume?: boolean }): Promise<{ ok: true }>
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): Promise<{ ok: true }>
  /** Renderer (re)attach: replayable terminal state, and open the data tap. */
  attach(): Promise<string>
  setFocus(focus: { focusedPath: string | null; openPaths: string[] }): void
  status(): AgentStatus
  dispose(): Promise<void>
}

interface Session {
  vaultId: string
  runtime: AgentRuntime
  mcp: McpServer
  mirror: TerminalMirror
}

export function createAgentManager(deps: AgentManagerDeps): AgentManager {
  const log = deps.log ?? ((msg: string) => console.log(`[agent] ${msg}`))
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS
  const resolveBin = deps.resolveBin ?? (() => resolveClaudeBin())

  let session: Session | null = null
  let mirror: VaultMirror | null = null
  let snapshot: ContextSnapshot | null = null
  let working = false
  let configStale = false
  let stopTimer: ReturnType<typeof setTimeout> | null = null
  /** False until a renderer has taken the terminal state: PTY output goes to
   * the mirror only, so nothing is streamed to a window that can't show it —
   * and nothing arrives twice on attach. */
  let attached = false

  const send = (channel: string, payload: unknown) => {
    deps.getWindow()?.webContents.send(channel, payload)
  }

  const status = (): AgentStatus => ({
    running: session !== null,
    working,
    configStale,
    authenticated: isClaudeAuthenticated(),
  })

  const pushStatus = () => send('agent:status', status())

  async function teardown(): Promise<void> {
    const current = session
    if (!current) return
    session = null // guard the double-stop: PTY exit also tears the MCP server down
    working = false
    attached = false
    if (stopTimer) {
      clearTimeout(stopTimer)
      stopTimer = null
    }
    await current.runtime.kill()
    await current.mcp.stop()
    current.mirror.dispose()
  }

  async function start({ vaultId, resume }: { vaultId: string; resume?: boolean }): Promise<{ ok: true }> {
    if (deps.vaultManager.activeVaultId() !== vaultId) {
      throw new Error('vault is not active — open it first')
    }
    const live = deps.vaultManager.activeMirror()
    if (!live) throw new Error('vault is not active — open it first')
    mirror = live

    await teardown() // restart semantics: one session at a time

    const bin = resolveBin()
    if (!bin) {
      throw new Error('Claude CLI not found on PATH — install it (https://claude.com/claude-code) and restart Holi')
    }

    const workRoot = deps.vaultManager.workRootFor(vaultId)
    const readIdentity = async (name: string) =>
      readFile(join(workRoot, '.claude', name), 'utf8').catch(() => null)
    const systemPrompt = buildSystemPrompt({
      identity: await readIdentity('IDENTITY.md'),
      soul: await readIdentity('SOUL.md'),
      tree: await readVaultTree(workRoot),
    })

    const token = randomBytes(32).toString('base64url')
    const mcp = new McpServer({
      token,
      ops: buildOps({
        client: deps.client,
        vaultId,
        // resolve against the LIVE mirror — adopted files show up mid-session
        docIdForPath: (rel) => mirror?.docIdForPath(rel) ?? null,
        pathForDocId: (id) => mirror?.pathForDocId(id) ?? null,
      }),
      onPreToolUse: ({ filePath }) => onPreToolUse(workRoot, filePath),
      onStop: () => onStop(),
    })
    const port = await mcp.start()

    const terminal = new TerminalMirror(SPAWN_COLS, SPAWN_ROWS)
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
        args: buildAgentArgs({ systemPrompt, mcpConfig: mcp.mcpConfig(), resume }),
        cwd: workRoot,
        env: buildAgentEnv(process.env, { endpoint: `http://127.0.0.1:${port}`, token }),
        cols: SPAWN_COLS,
        rows: SPAWN_ROWS,
      })
    } catch (err) {
      await mcp.stop() // never leak a bearer-gated port for a session that isn't there
      terminal.dispose()
      throw err
    }

    session = { vaultId, runtime, mcp, mirror: terminal }
    configStale = false
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

  /** PreToolUse: the write hasn't landed yet — open the turn so the pre-agent
   * snapshot and presence marker precede it. */
  function onPreToolUse(workRoot: string, filePath?: string): void {
    if (!filePath || !mirror) return
    const rel = toVaultRel(workRoot, filePath)
    if (!rel) return // outside the vault (path safety) — not our business
    mirror.bridgeForPath(rel)?.signalTurnOpen()
  }

  /** Stop: the agent is done. Settle first — the last write's watcher event may
   * still be in flight, and merging before it lands would strand that edit. */
  function onStop(): void {
    if (stopTimer) clearTimeout(stopTimer)
    stopTimer = setTimeout(() => {
      stopTimer = null
      mirror?.endOpenTurns()
    }, settleMs)
  }

  const observer: VaultObserver = {
    onActivated(vaultId, activeMirror) {
      mirror = activeMirror
      snapshot?.stop()
      snapshot = new ContextSnapshot({
        workRoot: deps.vaultManager.workRootFor(vaultId),
        listTasks: () => deps.client.tasks.list.query({ vaultId, filter: {} } as never) as Promise<Task[]>,
        backrefs: (path) => deps.client.notes.backrefs.query({ vaultId, path } as never),
        docIdForPath: (rel) => activeMirror.docIdForPath(rel),
        pathForDocId: (id) => activeMirror.pathForDocId(id),
      })
    },
    async onDeactivating() {
      // the agent dies BEFORE the mirror stops, so its open turns still merge
      await teardown()
      snapshot?.stop()
      snapshot = null
      mirror = null
      pushStatus()
    },
    onTurnActivity(activeTurns) {
      const next = activeTurns > 0
      if (next === working) return
      working = next
      pushStatus()
    },
    onMaterialize(rel) {
      if (!session || configStale) return
      if (!CONFIG_PATHS.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p))) return
      configStale = true
      pushStatus()
    },
    onTasksEvent(_event: TasksEvent) {
      // ContextSnapshot only needs to know *that* tasks moved — it re-reads the
      // related-task list from the server. The task file projection is what
      // consumes the payload (see TaskProjector).
      snapshot?.onTasksEvent()
    },
  }

  return {
    observer,
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
    setFocus: (focus) => snapshot?.setFocus(focus),
    status,
    dispose: async () => {
      await teardown()
      snapshot?.stop()
      snapshot = null
    },
  }
}
