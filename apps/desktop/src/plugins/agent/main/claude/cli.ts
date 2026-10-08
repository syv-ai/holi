/**
 * The one way Holi runs a `claude` command for a vault.
 *
 * **Every invocation gets the same environment.** A vault's sessions run under
 * a Claude Code supervisor keyed by its `CLAUDE_CONFIG_DIR`, and the
 * supervisor takes its environment from whichever `claude` process starts it.
 * Its workers inherit that, not the environment of the terminal that
 * dispatched them. So if a listing read started it with Electron's bare env,
 * every session would lose Holi's commands from `PATH`. One env for every
 * call makes the answer the same whoever gets there first.
 *
 * Holi never parses a TUI. The one piece of printed text it reads is the
 * documented first line of `claude --bg`, `backgrounded · <id> · <name>`,
 * because `--bg` ignores `--session-id` and says the new id nowhere else.
 *
 * No Electron import: this loads under plain Node like the rest of the plugin.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { resolveBin } from '../../../../main/plugin-api'
import type { TerminalCommand } from '../provider'

/**
 * The child's env. Strips the nested-session guards (`claude` refuses to run
 * inside another Claude Code session) and keeps PATH/HOME.
 *
 * `CLAUDE_CODE_NO_FLICKER=1` is forced on here rather than in the user's
 * `~/.claude/settings.json`, which Holi never touches.
 */
export interface AgentEnvOpts {
  /**
   * The directory holding Holi's generated commands, **prepended to `PATH`**.
   *
   * It exists for the send gate and the ask rules, which match the command
   * *text*: with `holi` on `PATH` the agent types the bare name.
   */
  binDir?: string | null
  /**
   * Holi's own Claude Code config directory, as `$CLAUDE_CONFIG_DIR`.
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
  // Reserved keys: strip any inherited value so a vault/user env can't spoof
  // them. Holi sets none of these: where it is comes from the vault's
  // `bridge.local.env`, which its commands read in preference to anything.
  delete env.HOLI_BRIDGE_PORT
  delete env.HOLI_BRIDGE_TOKEN
  delete env.HOLI_BIN
  // Reserved for the same reason: an inherited value would put the agent
  // back on the machine's `~/.claude`.
  delete env.CLAUDE_CONFIG_DIR
  if (opts.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir
  // Prepended, never appended: an earlier `holi` on the
  // inherited PATH would otherwise win under a name the gate trusts.
  if (opts.binDir) {
    env.PATH = env.PATH ? `${opts.binDir}:${env.PATH}` : opts.binDir
  }
  return env
}

/** `HOLI_CLAUDE_BIN` when it is set and runs, else `claude` as `resolveBin`
 *  finds it. */
export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.HOLI_CLAUDE_BIN
  if (override && isExecutable(override)) return override
  return resolveBin('claude', env)
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A listing is read on a filesystem edge, so a hung CLI would queue reads. */
const LIST_TIMEOUT_MS = 3_000
/** Starting a background session may first start the supervisor. */
const ACTION_TIMEOUT_MS = 20_000

/** Where a vault's commands run, and on which config directory. */
export interface VaultCliTarget {
  /** The vault clone: the cwd, which is where a new session starts. */
  root: string
  /** The vault's own Claude Code config directory. */
  configDir: string
  /** Holi's generated commands, prepended to `PATH`. */
  binDir: string | null
}

export interface RunOptions {
  cwd: string
  env: Record<string, string>
  timeoutMs: number
}

export interface ClaudeCliDeps {
  /** Injected so tests never shell out. */
  resolveBin?: () => string | null
  run?: (bin: string, args: string[], opts: RunOptions) => Promise<string>
  log?: (msg: string) => void
}

export type ActionResult = { ok: true } | { ok: false; message: string }
export type StartResult = { ok: true; id: string } | { ok: false; message: string }

export interface ClaudeCli {
  /** `claude agents --json`, raw. Null for every failure: no binary, a
   *  non-zero exit, a timeout. */
  list(target: VaultCliTarget): Promise<string | null>
  stop(target: VaultCliTarget, id: string): Promise<ActionResult>
  respawn(target: VaultCliTarget, id: string): Promise<ActionResult>
  /** Remove a stopped session from Claude Code's list, conversation and all. */
  rm(target: VaultCliTarget, id: string): Promise<ActionResult>
  /** A new background session in the vault. With no prompt it waits for its
   *  first one; with a prompt, that prompt is its first turn. `model` and
   *  `allow` (Claude Code permission rules it may use without asking) are a
   *  scheduled run's. */
  startBg(target: VaultCliTarget, opts: StartBgOptions): Promise<StartResult>
  /** A background copy of a conversation, by Claude Code's full session id. */
  forkBg(target: VaultCliTarget, sessionId: string, name?: string): Promise<StartResult>
}

export interface StartBgOptions {
  name?: string
  prompt?: string
  model?: string
  allow?: readonly string[]
}

/** The longest a session name is worth being: a row is narrow, and the source
 *  is usually the first line of a sentence someone selected. */
const MAX_NAME = 60

/**
 * A name fit for argv, or null. First line only, whitespace collapsed, capped:
 * a newline would split the argument in two.
 */
export function sessionName(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const line = raw.split('\n')[0] ?? ''
  const clean = line.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim()
  return clean === '' ? null : clean
}

// eslint-disable-next-line no-control-regex -- stripping the terminal's own colour codes
const ANSI = /\x1b\[[0-9;]*m/g

/** The id out of `backgrounded · <id> · <name>`, or null. */
export function parseBackgrounded(stdout: string): string | null {
  const plain = stdout.replace(ANSI, '')
  const match = /^backgrounded\s+·\s+([0-9a-f]{8})\b/m.exec(plain)
  return match?.[1] ?? null
}

/** The environment every `claude` Holi runs for a vault gets. */
export function cliEnv(base: NodeJS.ProcessEnv, target: VaultCliTarget): Record<string, string> {
  return buildAgentEnv(base, { configDir: target.configDir, binDir: target.binDir })
}

/** The binary when it is not on the machine. */
export const NOT_INSTALLED =
  'Claude CLI not found on PATH. Install it (https://claude.com/claude-code) and restart Holi.'

/** What a terminal runs: `claude agents` (the list) or `claude attach <id>`.
 *  Null when the binary is not on this machine. */
export function terminalCommand(
  target: VaultCliTarget,
  attach?: string,
  resolveBin: () => string | null = () => resolveClaudeBin(),
): TerminalCommand | null {
  const bin = resolveBin()
  if (bin === null) return null
  return {
    bin,
    args: attach === undefined ? ['agents'] : ['attach', attach],
    env: cliEnv(process.env, target),
  }
}

function defaultRun(bin: string, args: string[], opts: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || String(err))) : resolve(stdout)),
    )
    // No input, and saying so at once: `claude --bg` reads a piped stdin as
    // part of the prompt and waits for its end, which execFile's open pipe
    // never sends, so every start sat out Claude Code's stdin wait (~3 s).
    child.stdin?.end()
  })
}

export function createClaudeCli(deps: ClaudeCliDeps = {}): ClaudeCli {
  const log = deps.log ?? ((msg: string) => console.log(`[claude-cli] ${msg}`))
  const resolveBin = deps.resolveBin ?? (() => resolveClaudeBin())
  const run = deps.run ?? defaultRun

  async function exec(target: VaultCliTarget, args: string[], timeoutMs: number): Promise<string> {
    const bin = resolveBin()
    if (bin === null) {
      throw new Error(NOT_INSTALLED)
    }
    return run(bin, args, { cwd: target.root, env: cliEnv(process.env, target), timeoutMs })
  }

  async function action(target: VaultCliTarget, args: string[]): Promise<ActionResult> {
    try {
      await exec(target, args, ACTION_TIMEOUT_MS)
      return { ok: true }
    } catch (err: unknown) {
      log(`${args[0]} failed: ${String(err)}`)
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async function start(target: VaultCliTarget, args: string[]): Promise<StartResult> {
    let stdout: string
    try {
      stdout = await exec(target, args, ACTION_TIMEOUT_MS)
    } catch (err: unknown) {
      log(`--bg failed: ${String(err)}`)
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    const id = parseBackgrounded(stdout)
    if (id === null)
      return { ok: false, message: 'Claude Code did not say which session it started.' }
    return { ok: true, id }
  }

  return {
    async list(target) {
      try {
        return await exec(target, ['agents', '--json'], LIST_TIMEOUT_MS)
      } catch (err: unknown) {
        log(`listing failed: ${String(err)}`)
        return null
      }
    },
    stop: (target, id) => action(target, ['stop', id]),
    respawn: (target, id) => action(target, ['respawn', id]),
    rm: (target, id) => action(target, ['rm', id]),
    startBg(target, { name, prompt, model, allow = [] }) {
      const label = sessionName(name)
      return start(target, [
        '--bg',
        ...(model === undefined ? [] : ['--model', model]),
        // `--allowedTools` takes any number of values, so each rule is one
        // `=` argument and a plain option always follows to end the list:
        // the name, which an allow list therefore always gets.
        ...allow.map((rule) => `--allowedTools=${rule}`),
        ...(label === null
          ? allow.length > 0
            ? ['--name', 'Scheduled run']
            : []
          : ['--name', label]),
        ...(prompt ? [prompt] : []),
      ])
    },
    forkBg(target, sessionId, name) {
      const label = sessionName(name)
      return start(target, [
        '--bg',
        '--resume',
        sessionId,
        '--fork-session',
        ...(label === null ? [] : ['--name', label]),
      ])
    },
  }
}
