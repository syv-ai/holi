/**
 * The `claude` session itself: one interactive CLI in a node-pty PTY, its bytes
 * forwarded to the renderer's xterm.
 *
 * node-pty is an Electron-ABI native module, so it loads lazily inside the
 * real spawn path only; tests inject a fake PTY and never touch it. Everything above the PTY (env, args, binary discovery) is a pure
 * function.
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
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
 * What a pid is at the moment we are about to signal it.
 *  - `group-leader` — still the session leader we spawned; safe to signal the group
 *  - `alive`        — a live process that does NOT lead its own group
 *  - `gone`         — no such pid; nothing of ours to signal
 */
export type PidState = 'group-leader' | 'alive' | 'gone'

/**
 * Ask the OS what `pid` currently is. A node-pty child is setsid'd, so it leads
 * a group whose id equals its own pid; that equality is what distinguishes our
 * child from a stranger who was handed the same pid after ours was reaped.
 */
export const defaultProbePid = (pid: number): PidState => {
  // pid 0 is "my own process group" and pid 1 is launchd — signalling either
  // would be catastrophic, so they can never be ours.
  if (!Number.isInteger(pid) || pid <= 1) return 'gone'
  try {
    const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return Number(pgid) === pid ? 'group-leader' : 'alive'
  } catch {
    return 'gone' // ps exits non-zero when the pid does not exist
  }
}

/**
 * The child's env. Strips the nested-session guards (`claude` refuses to run
 * inside another Claude Code session) and keeps PATH/HOME.
 *
 * `CLAUDE_CODE_NO_FLICKER=1` is forced on here rather than in the user's
 * `~/.claude/settings.json`, which Holi never touches.
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
  /** Absolute path to the generated `holi` command, as `$HOLI_BIN`. The agent
   *  types the bare name; this is for a hook or a script that needs the path. */
  holiBin?: string | null
  /**
   * The directory holding Holi's generated commands, **prepended to `PATH`**.
   *
   * It exists for the send gate (D70). The gate is a `PreToolUse` hook matching
   * the command *text*, and `"$HOLI_GOOGLE_BIN" send` contains no `holi-google`
   * at all, so the agent has to type the bare name. `holi` lives in the same
   * directory.
   */
  binDir?: string | null
  /**
   * Holi's own Claude Code config directory, as `$CLAUDE_CONFIG_DIR` (D72).
   *
   * This is the whole of the isolation: the variable relocates *every*
   * `~/.claude` path, and `~/.claude.json` with them, so a vault session sees
   * nothing from the machine's config. Absolute path only.
   */
  configDir?: string | null
}

export function buildAgentEnv(
  base: NodeJS.ProcessEnv,
  opts: AgentEnvOpts = {},
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value
  }
  // The parent session's identity, when Holi itself was launched from a Claude
  // Code terminal. None of it is true of the vault agent: `CHILD_SESSION`
  // disables transcript saving, and the messaging pair is a live channel back
  // into the parent.
  //
  // Named individually rather than stripped by prefix: several other
  // `CLAUDE_CODE_*` variables are documented configuration, and swallowing those
  // would break someone tuning the agent on purpose.
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  delete env.CLAUDE_CODE_CHILD_SESSION
  delete env.CLAUDE_CODE_SESSION_ID
  delete env.CLAUDE_CODE_MESSAGING_SOCKET
  delete env.CLAUDE_CODE_MESSAGING_TOKEN
  delete env.CLAUDE_CODE_EXECPATH
  env.TERM = 'xterm-256color'
  /**
   * The flicker-free alt-screen renderer, for every session Holi starts.
   *
   * The classic renderer redraws the whole screen and visibly flickers inside
   * the embedded xterm.js; this one patches a virtual viewport instead.
   *
   * **The `delete` is the load-bearing half.** Claude Code checks an explicit
   * "off" BEFORE our "on", and `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` being set
   * at all counts as off, so an inherited one would silently win.
   *
   * `CLAUDE_CODE_ACCESSIBILITY` is deliberately NOT stripped: it disables this
   * renderer too, and a screen-reader user's choice outranks ours.
   */
  delete env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN
  env.CLAUDE_CODE_NO_FLICKER = '1'
  // Reserved keys: strip any inherited value so a vault/user env can't spoof the
  // hook target, then set our own only when a live server is running.
  delete env.HOLI_HOOK_PORT
  delete env.HOLI_HOOK_TOKEN
  delete env.HOLI_GOOGLE_PORT
  delete env.HOLI_GOOGLE_TOKEN
  delete env.HOLI_GOOGLE_BIN
  delete env.HOLI_BIN
  // Reserved for the same reason (D72): an inherited value would put the agent
  // back on the machine's `~/.claude`.
  delete env.CLAUDE_CONFIG_DIR
  if (opts.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir
  if (opts.hookPort != null) env.HOLI_HOOK_PORT = String(opts.hookPort)
  if (opts.hookToken) env.HOLI_HOOK_TOKEN = opts.hookToken
  if (opts.typstBin) env.TYPST_BIN = opts.typstBin
  if (opts.googlePort != null) env.HOLI_GOOGLE_PORT = String(opts.googlePort)
  if (opts.googleToken) env.HOLI_GOOGLE_TOKEN = opts.googleToken
  if (opts.googleBin) env.HOLI_GOOGLE_BIN = opts.googleBin
  if (opts.holiBin) env.HOLI_BIN = opts.holiBin
  // Prepended, never appended: an earlier `holi-google` or `holi` on the
  // inherited PATH would otherwise win under a name the gate trusts.
  if (opts.binDir) {
    env.PATH = env.PATH ? `${opts.binDir}:${env.PATH}` : opts.binDir
  }
  return env
}

export interface AgentArgs {
  /**
   * What to call this session (D100).
   *
   * **Claude Code's own name, not a label Holi keeps beside one.** It shows in
   * the prompt box, the `/resume` picker and the terminal title, and comes back
   * in Claude Code's session listing, which Holi's tabs read. A session started
   * with no name gets a default display name (the cwd's name plus a short
   * suffix) that says nothing about the conversation, so Holi shows "New
   * session" instead.
   *
   * Normalised here rather than at the call sites, because it goes into argv.
   */
  name?: string
  /** Bare `--resume` — the CLI shows its own session picker in the terminal. */
  resume?: boolean
  /** A first message to seed the interactive session with (the reconcile flow).
   *  `claude "<prompt>"` starts interactive and auto-submits it as turn one — a
   *  positional arg, NOT a system prompt and NOT a keystroke written into the TUI. */
  prompt?: string
  /**
   * Claude Code's own session id to **fork**: `--resume <id> --fork-session`
   * copies that conversation into a new session and leaves the original alone.
   *
   * Read out of the listing at the moment of the fork and never stored: the id
   * changes under one terminal on `/clear` (D100).
   */
  forkOf?: string
}

/** The longest a session name is worth being: a tab is narrow, and the source is
 *  usually the first line of a sentence someone typed at an editor selection. */
const MAX_NAME = 60

/**
 * A name fit for argv, or null.
 *
 * First line only, whitespace collapsed, capped. A newline would split the
 * argument and everything after it would arrive as a second one; the rest is
 * about a tab being narrow rather than about safety.
 */
export function sessionName(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const line = raw.split('\n')[0] ?? ''
  const clean = line.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim()
  return clean === '' ? null : clean
}

/**
 * The interactive `claude` invocation, deliberately bare. NO
 * `--append-system-prompt`: vault conventions live in `AGENTS.md`, which Claude
 * Code reads natively (docs/features/agent-config.md). And no
 * `--strict-mcp-config`, which would suppress MCP servers the *vault* configures
 * in `.claude/`.
 */
export function buildAgentArgs({ name, resume, forkOf, prompt }: AgentArgs = {}): string[] {
  const label = sessionName(name)
  return [
    ...(label === null ? [] : ['--name', label]),
    // A fork names the conversation it copies and asks for a copy; bare
    // `--resume` shows Claude Code's own picker instead. They are the same flag
    // with and without an argument, so only one of them can be passed.
    ...(forkOf !== undefined ? ['--resume', forkOf, '--fork-session'] : resume ? ['--resume'] : []),
    ...(prompt ? [prompt] : []),
  ]
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
 * There is deliberately **no login probe** (D72). Claude Code asks for the login
 * itself, in the terminal; a copy of that state in Holi's chrome cannot be kept
 * in sync, because `/login` fires none of the events Holi sees.
 */

export interface AgentRuntimeDeps {
  spawnPty?: SpawnPty
  /** Liveness/ownership probe used before every signal (see `signal()`). */
  probePid?: (pid: number) => PidState
  /** SIGTERM → grace → SIGKILL. */
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
  private readonly probePid: (pid: number) => PidState
  private readonly killGraceMs: number
  private readonly killBackstopMs: number

  constructor(deps: AgentRuntimeDeps = {}) {
    this.spawnPty = deps.spawnPty ?? defaultSpawnPty
    this.probePid = deps.probePid ?? defaultProbePid
    this.killGraceMs = deps.killGraceMs ?? 2_000
    this.killBackstopMs = deps.killBackstopMs ?? 5_000
  }

  get isRunning(): boolean {
    return this.pty !== null
  }

  /**
   * The child's pid while it runs, null otherwise.
   *
   * **The join key to Claude Code's own session listing** (D100): a row there is
   * keyed by pid, and this is how Holi says which of its sessions a row is
   * about. Derived from `this.pty`, which `onExit` clears before it emits, so a
   * dead session reports null.
   */
  get pid(): number | null {
    return this.pty?.pid ?? null
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

  /**
   * Signal the child, choosing the target from what the pid IS right now.
   *
   * ┌─ READ THIS BEFORE TOUCHING THE KILL PATH ────────────────────────────┐
   * Never an unconditional `process.kill(-pty.pid, signal)`: that once killed
   * unrelated applications on a developer's machine.
   *
   * `kill(-pid)` signals an entire process GROUP, and node-pty reports the
   * child's exit asynchronously. Between the kernel reaping the child (which
   * frees its pid for reuse *immediately*) and our `onExit` running, `this.pty`
   * still looks live, so a signal could hit a pid the OS already handed to
   * someone else, and the negative of it kills their whole group. The window is
   * tiny but lands under heavy pid churn plus load. Guard it anyway.
   *
   * So: never signal a pid on the strength of a JS object still existing. Ask
   * the OS what the pid is, immediately before signalling, every time.
   *   - `group-leader` → still our setsid'd child; signal the group, which is
   *     the whole point here (claude's helpers — node sidecars, ripgrep — die
   *     with it instead of leaking).
   *   - `alive` → a live pid that does not lead its own group, so it cannot be
   *     our node-pty child's session. Signal only the child via node-pty; NEVER
   *     negate a pid we have not positively identified as ours.
   *   - `gone` → already reaped. Send nothing. There is no one left to signal
   *     and the pid may already belong to someone else.
   * └──────────────────────────────────────────────────────────────────────┘
   */
  private signal(pty: PtyProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
    // Cheap guard first: onExit nulls `this.pty`, so a mismatch means we
    // already know it is dead without paying for a probe.
    if (this.pty !== pty) return

    switch (this.probePid(pty.pid)) {
      case 'group-leader':
        try {
          process.kill(-pty.pid, signal) // negative pid = the whole group
        } catch {
          // Reaped between the probe and here: the residual race is now bounded
          // by these two statements rather than by a callback round-trip. The
          // pid cannot have been *reused* that fast, so this is a plain no-op.
        }
        return
      case 'alive':
        try {
          pty.kill(signal)
        } catch {
          // raced with exit
        }
        return
      case 'gone':
        return
    }
  }
}
