/**
 * The `claude` session itself (spec §AgentRuntime): one interactive CLI in a
 * node-pty PTY, its bytes forwarded to the renderer's xterm.
 *
 * node-pty is an Electron-ABI native module, so it loads lazily inside the
 * real spawn path only (plan decision 6) — tests inject a fake PTY and never
 * touch it. Everything above the PTY (env, args, binary discovery, the auth
 * probe) is a pure function.
 */
import { accessSync, constants, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The slice of node-pty's IPty we depend on (tests implement it directly). */
export interface PtyProcess {
  readonly pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface SpawnPtyOptions {
  cwd: string
  env: Record<string, string>
  /** Omitted → node-pty's own native default (80×24). */
  cols?: number
  rows?: number
}

export type SpawnPty = (file: string, args: string[], opts: SpawnPtyOptions) => PtyProcess

/** The only place node-pty is loaded — never reached under vitest. */
export const defaultSpawnPty: SpawnPty = (file, args, opts) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require('node-pty') as typeof import('node-pty')
  return pty.spawn(file, args, { name: 'xterm-256color', ...opts }) as unknown as PtyProcess
}

/**
 * The child's env. Strips the nested-session guards (`claude` refuses to run
 * inside another Claude Code session) and keeps PATH/HOME.
 *
 * It no longer hands the child an endpoint or a bearer: there is no MCP server
 * to reach (D60). The one surviving hook, `user-prompt-submit`, reads the
 * vault's own files and needs nothing from us.
 *
 * `CLAUDE_CODE_NO_FLICKER=1` is forced on for every in-app session: the default
 * full-screen-redraw renderer flickers badly inside an embedded xterm.js, and
 * NO_FLICKER swaps in a patch-only virtual viewport (docs:
 * code.claude.com/docs/en/terminal-config). Set here rather than in the user's
 * `~/.claude/settings.json`, which the PRD says Holi never touches.
 */
export interface AgentEnvOpts {
  /** The local hook server's port (git coexistence). The seeded curl hooks read
   *  it live from `$HOLI_HOOK_PORT`; null/omitted leaves the child hook-less. */
  hookPort?: number | null
  hookToken?: string | null
  /** The resolved typst binary (find-only). Set as `$TYPST_BIN` so the seeded
   *  md-to-pdf skill can render with the same engine the UI's Convert uses. */
  typstBin?: string | null
  /** The Google ops channel (D67): where `holi-google` sends its requests, and
   *  the per-instance token that proves it is us. The agent never receives a
   *  Google token — main holds those and makes the calls itself. */
  googlePort?: number | null
  googleToken?: string | null
  /** Absolute path to the generated `holi-google` command, as `$HOLI_GOOGLE_BIN`
   *  — the same shape as `$TYPST_BIN`, and what the seeded skill invokes. */
  googleBin?: string | null
  /**
   * The directory holding that command, **prepended to `PATH`** (D70).
   *
   * This exists for the send gate, not for convenience. The gate is a
   * `PreToolUse` hook matching the command text, so the command text has to be
   * something a rule can match — and `"$HOLI_GOOGLE_BIN" send` contains no
   * `holi-google` at all. That is precisely why D67 §5's planned
   * `Bash(holi-google send:*)` rule would never have fired.
   */
  googleBinDir?: string | null
  /**
   * Holi's own Claude Code config directory, as `$CLAUDE_CONFIG_DIR` (D72).
   *
   * This is the whole of the isolation: the variable relocates *every*
   * `~/.claude` path — settings, skills, plugins, marketplaces, MCP — and
   * `~/.claude.json` with them, so a vault session sees Holi's config and the
   * vault's, and nothing from the machine. Absolute path only; the agent's cwd
   * is the vault and Claude Code resolves this against nothing useful.
   */
  configDir?: string | null
}

export function buildAgentEnv(base: NodeJS.ProcessEnv, opts: AgentEnvOpts = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value
  }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  env.TERM = 'xterm-256color'
  env.CLAUDE_CODE_NO_FLICKER = '1'
  // Reserved keys: strip any inherited value so a vault/user env can't spoof the
  // hook target, then set our own only when a live server is running.
  delete env.HOLI_HOOK_PORT
  delete env.HOLI_HOOK_TOKEN
  delete env.HOLI_GOOGLE_PORT
  delete env.HOLI_GOOGLE_TOKEN
  delete env.HOLI_GOOGLE_BIN
  // Reserved for the same reason and more strongly (D72): an inherited value
  // would put the agent straight back on the machine's `~/.claude`, which is the
  // one thing this variable exists to prevent.
  delete env.CLAUDE_CONFIG_DIR
  if (opts.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir
  if (opts.hookPort != null) env.HOLI_HOOK_PORT = String(opts.hookPort)
  if (opts.hookToken) env.HOLI_HOOK_TOKEN = opts.hookToken
  if (opts.typstBin) env.TYPST_BIN = opts.typstBin
  if (opts.googlePort != null) env.HOLI_GOOGLE_PORT = String(opts.googlePort)
  if (opts.googleToken) env.HOLI_GOOGLE_TOKEN = opts.googleToken
  if (opts.googleBin) env.HOLI_GOOGLE_BIN = opts.googleBin
  // Prepended, never appended: an earlier `holi-google` on the inherited PATH
  // would otherwise win, and the agent would be talking to something else
  // entirely under a name the gate trusts.
  if (opts.googleBinDir) {
    env.PATH = env.PATH ? `${opts.googleBinDir}:${env.PATH}` : opts.googleBinDir
  }
  return env
}

export interface AgentArgs {
  /** Bare `--resume` — the CLI shows its own session picker in the terminal. */
  resume?: boolean
  /** A first message to seed the interactive session with (the reconcile flow).
   *  `claude "<prompt>"` starts interactive and auto-submits it as turn one — a
   *  positional arg, NOT a system prompt and NOT a keystroke written into the TUI. */
  prompt?: string
}

/**
 * The interactive `claude` invocation — deliberately bare. This is a normal
 * terminal session, not a headless/`--print` run. Holi builds no prompt content,
 * so there is NO `--append-system-prompt`: vault conventions live in `AGENTS.md`,
 * which Claude Code reads natively from the cwd (prd/agent.md §Per-turn). And no
 * `--mcp-config`/`--strict-mcp-config` — Holi declares no MCP servers, and
 * `--strict-mcp-config` would additionally suppress any the *vault* configures
 * natively in `.claude/`, which it is entitled to do.
 */
export function buildAgentArgs({ resume, prompt }: AgentArgs = {}): string[] {
  return [...(resume ? ['--resume'] : []), ...(prompt ? [prompt] : [])]
}

/** GUI apps don't inherit a login shell's PATH — check the usual install dirs. */
const FALLBACK_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '.local/bin',
  '.bun/bin',
  '.volta/bin',
  '.npm-global/bin',
  'n/bin',
]

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.HOLI_CLAUDE_BIN
  if (override && isExecutable(override)) return override

  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, 'claude')
    if (isExecutable(candidate)) return candidate
  }

  const home = env.HOME ?? homedir()
  for (const dir of FALLBACK_BIN_DIRS) {
    const candidate = dir.startsWith('/') ? join(dir, 'claude') : join(home, dir, 'claude')
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/**
 * Best-effort login probe: does `dir` carry a logged-in Claude Code?
 *
 * `dir` is **the config directory the child will actually use** — since D72
 * that is Holi's own, not the machine's home, and asking the wrong one would
 * report a login the relocated agent does not have. It is also the reason this
 * is a file read: the logged-out state is visible in the terminal as
 * `Not logged in`, and Holi does not infer Claude Code's state from its output.
 *
 * Only powers a header hint — `/login` works in the same terminal if this is
 * wrong. Defaults to the home directory, which is where a config dir-less
 * session (tests) would look anyway.
 */
export function isClaudeAuthenticated(dir: string = homedir()): boolean {
  for (const path of [join(dir, '.claude.json'), join(dir, '.claude', '.claude.json')]) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { oauthAccount?: unknown }
      if (parsed.oauthAccount != null) return true
    } catch {
      // missing or unparseable — try the fallback, then give up
    }
  }
  return false
}

export interface AgentRuntimeDeps {
  spawnPty?: SpawnPty
  /** SIGTERM → grace → SIGKILL (the old app's 2s). */
  killGraceMs?: number
  /** Cap on waiting for the exit event after SIGKILL. */
  killBackstopMs?: number
}

export interface StartArgs {
  bin: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols?: number
  rows?: number
}

export interface AgentExit {
  exitCode: number
  signal?: number
}

export class AgentRuntime {
  private pty: PtyProcess | null = null
  private dataCbs: Array<(data: string) => void> = []
  private exitCbs: Array<(e: AgentExit) => void> = []
  private exitWaiters: Array<() => void> = []
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private readonly spawnPty: SpawnPty
  private readonly killGraceMs: number
  private readonly killBackstopMs: number

  constructor(deps: AgentRuntimeDeps = {}) {
    this.spawnPty = deps.spawnPty ?? defaultSpawnPty
    this.killGraceMs = deps.killGraceMs ?? 2_000
    this.killBackstopMs = deps.killBackstopMs ?? 5_000
  }

  get isRunning(): boolean {
    return this.pty !== null
  }

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb)
  }

  onExit(cb: (e: AgentExit) => void): void {
    this.exitCbs.push(cb)
  }

  start({ bin, args, cwd, env, cols, rows }: StartArgs): void {
    if (this.pty) throw new Error('agent session already running')
    // cols/rows pass straight through — undefined lets node-pty default natively.
    const pty = this.spawnPty(bin, args, { cwd, env, cols, rows })
    this.pty = pty
    pty.onData((data) => {
      for (const cb of this.dataCbs) cb(data)
    })
    pty.onExit((e) => {
      // clear session state BEFORE emitting: listeners restart on exit, and a
      // restart racing a stale `pty` would spawn into a half-dead runtime
      if (this.pty === pty) this.pty = null
      if (this.killTimer) {
        clearTimeout(this.killTimer)
        this.killTimer = null
      }
      for (const cb of this.exitCbs) cb({ exitCode: e.exitCode, signal: e.signal })
      for (const resolve of this.exitWaiters.splice(0)) resolve()
    })
  }

  write(data: string): void {
    this.pty?.write(data)
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)))
  }

  /**
   * SIGTERM the child's whole **process group** (node-pty children are session
   * leaders, so `claude`'s helper subprocesses — node sidecars, ripgrep — die
   * with it; a bare pty.kill leaks them), escalating to SIGKILL after the
   * grace period. Resolves when the child is actually reaped.
   */
  async kill(): Promise<void> {
    const pty = this.pty
    if (!pty) return

    const exited = new Promise<void>((resolve) => {
      this.exitWaiters.push(resolve)
      setTimeout(resolve, this.killBackstopMs) // never hang a vault switch on a zombie
    })

    this.signal(pty, 'SIGTERM')
    this.killTimer = setTimeout(() => {
      this.killTimer = null
      if (this.pty === pty) this.signal(pty, 'SIGKILL')
    }, this.killGraceMs)

    await exited
  }

  private signal(pty: PtyProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
    try {
      process.kill(-pty.pid, signal) // negative pid = the whole group
    } catch {
      // no such group (already reaped, or the child never led one) — fall back
      // to the pty's own kill so a live child still gets the signal
      try {
        pty.kill(signal)
      } catch {
        // already gone
      }
    }
  }
}
