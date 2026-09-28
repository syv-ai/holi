/**
 * The one way Holi runs a `claude` command for a vault (D110).
 *
 * **Every invocation gets the same environment.** A vault's sessions run under
 * a Claude Code supervisor keyed by its `CLAUDE_CONFIG_DIR` (D86), and the
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
 * No Electron import: this loads under plain Node like the rest of `agent/`.
 */
import { execFile } from 'node:child_process'
import { buildAgentEnv, resolveClaudeBin } from './agent-runtime'

/** A listing is read on a filesystem edge, so a hung CLI would queue reads. */
const LIST_TIMEOUT_MS = 3_000
/** Starting a background session may first start the supervisor. */
const ACTION_TIMEOUT_MS = 20_000

/** Where a vault's commands run, and on which config directory. */
export interface VaultCliTarget {
  /** The vault clone: the cwd, which is where a new session starts. */
  root: string
  /** The vault's own Claude Code config directory (D86). */
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
  /** A new background session in the vault. With no prompt it waits for its
   *  first one; with a prompt, that prompt is its first turn. */
  startBg(target: VaultCliTarget, opts: { name?: string; prompt?: string }): Promise<StartResult>
  /** A background copy of a conversation, by Claude Code's full session id. */
  forkBg(target: VaultCliTarget, sessionId: string, name?: string): Promise<StartResult>
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

function defaultRun(bin: string, args: string[], opts: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
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
  })
}

export function createClaudeCli(deps: ClaudeCliDeps = {}): ClaudeCli {
  const log = deps.log ?? ((msg: string) => console.log(`[claude-cli] ${msg}`))
  const resolveBin = deps.resolveBin ?? (() => resolveClaudeBin())
  const run = deps.run ?? defaultRun

  async function exec(target: VaultCliTarget, args: string[], timeoutMs: number): Promise<string> {
    const bin = resolveBin()
    if (bin === null) {
      throw new Error(
        'Claude CLI not found on PATH. Install it (https://claude.com/claude-code) and restart Holi.',
      )
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
    startBg(target, { name, prompt }) {
      const label = sessionName(name)
      return start(target, [
        '--bg',
        ...(label === null ? [] : ['--name', label]),
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
