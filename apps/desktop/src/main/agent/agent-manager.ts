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
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { AGENT_CONFIG_FILES } from '@holi/shared'
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
  /** A synced agent-config file (`AGENT_CONFIG_FILES`) changed on disk since this
   *  session launched, so the live agent is running against stale config until it
   *  restarts. Detected by fingerprinting those files at spawn and re-checking on
   *  each vault change; sticky until a restart, which is what actually re-reads
   *  config. Drives the AgentPanel's "shared config changed; restart" nudge. */
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
  /** Find-only typst path for the child's `$TYPST_BIN` (the md-to-pdf skill).
   *  No download — the resolver only looks. Null when typst isn't installed. */
  resolveTypstBin?: () => Promise<string | null>
  /** Fire-and-forget: cache typst for next time if the machine has never
   *  rendered. Never awaited — the download must not block the spawn path. */
  warmTypst?: () => void
  log?: (msg: string) => void
}

export interface AgentManager {
  start(args: {
    vaultId: string
    resume?: boolean
    cols?: number
    rows?: number
    /** Seed the interactive session's first turn (the reconcile flow). */
    prompt?: string
  }): Promise<{ ok: true }>
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): Promise<{ ok: true }>
  /** Renderer (re)attach: replayable terminal state, and open the data tap. */
  attach(): Promise<string>
  setFocus(focus: FocusInput): void
  /** Turn bracket from the hook server: true on UserPromptSubmit, false on Stop.
   *  Drives the vault pause/resume and status().working. No-op with no session. */
  setTurnActive(active: boolean): void
  /** The vault's files changed on disk (wired to the host's snapshot signal).
   *  Re-fingerprints the agent-config files and flips `configStale` if a synced
   *  one changed under the live session. No-op with no session, or once stale. */
  notifyVaultChanged(): Promise<void>
  status(): AgentStatus
  dispose(): Promise<void>
}

interface Session {
  vaultId: string
  /** The clone dir the session launched in — the root its config fingerprint is
   *  read from. Held so a vault switch can't point the check at the wrong tree. */
  root: string
  runtime: AgentRuntime
  mirror: TerminalMirror
  snapshot: ContextSnapshot
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
  /** Set once a synced config file changes under the live session; sticky until
   *  a restart clears it. `configBaseline` is the fingerprint captured at spawn. */
  let configStale = false
  let configBaseline: string | null = null
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
    configStale,
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
    // The next session captures its own baseline; a dead session is never stale.
    configStale = false
    configBaseline = null
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
    prompt,
  }: {
    vaultId: string
    resume?: boolean
    /** The drawer's fitted geometry. Absent (e.g. a reconcile-seeded start with
     *  no renderer) → node-pty and xterm use their own native 80×24. */
    cols?: number
    rows?: number
    /** Seed the interactive session's first turn (the reconcile flow). */
    prompt?: string
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
    // Find-only ($TYPST_BIN for the md-to-pdf skill) — a fast `which`, never a
    // download. Then warm the cache fire-and-forget so a machine that has never
    // rendered has typst next time; the download must never block this spawn.
    const typstBin = (await deps.resolveTypstBin?.()) ?? null
    deps.warmTypst?.()
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
        args: buildAgentArgs({ resume, prompt }), // prompt seeds the reconcile turn; no systemPrompt
        cwd: workRoot,
        env: buildAgentEnv(process.env, {
          hookPort: deps.hookPort?.() ?? null,
          hookToken: deps.hookToken?.() ?? null,
          typstBin,
        }),
        cols,
        rows,
      })
    } catch (err) {
      snapshot.stop()
      terminal.dispose()
      throw err
    }

    session = { vaultId, root: workRoot, runtime, mirror: terminal, snapshot }
    // Baseline the config the child just loaded, so a later change reads as stale.
    // `teardown` (run at the head of every start) already cleared the old flag.
    configBaseline = await fingerprintAgentConfig(workRoot)
    pushStatus()
    return { ok: true }
  }

  /**
   * A vault file changed on disk (wired to the host's snapshot signal). Re-check
   * the config fingerprint; if a synced agent-config file moved since spawn, the
   * live agent is stale until it restarts. Cheap and skipped once already stale
   * (sticky) or with no session — a handful of small reads on a change that is
   * already debounced upstream by the watcher.
   */
  async function notifyVaultChanged(): Promise<void> {
    if (session === null || configStale || configBaseline === null) return
    const current = await fingerprintAgentConfig(session.root)
    // The session may have died during the await; only a still-live, still-fresh
    // one flips.
    if (session === null || configStale) return
    if (current !== configBaseline) {
      configStale = true
      pushStatus()
    }
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
    notifyVaultChanged,
    status,
    dispose: async () => {
      await teardown()
    },
  }
}
