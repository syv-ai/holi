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
import { join } from 'node:path'
import { PLUGIN_COMMANDS_DIR } from '@holi/shared'
import {
  delimiterFor,
  execProgram,
  isRunnable,
  nodeFallbackDir,
  resolveBin,
  toolPath,
  UnconfirmedOwnedProgramError,
  withPath,
} from '../../../../main/plugin-api'
import type { TerminalCommand } from '../provider'
import { parseListing } from './listing'

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
   * The vault's community plugin commands (`PLUGIN_COMMANDS_DIR`), **appended
   * to `PATH`**: last, so a plugin adds a command but never stands in for one
   * the machine has. Linking refuses a name already on `PATH`, so nothing
   * there goes unreached.
   */
  commandsDir?: string | null
  /**
   * Holi's own Claude Code config directory, as `$CLAUDE_CONFIG_DIR`.
   *
   * This is the whole of the isolation: the variable relocates *every*
   * `~/.claude` path, and `~/.claude.json` with them, so a vault session sees
   * nothing from the machine's config. Absolute path only.
   */
  configDir?: string | null
  /** The OS the environment is for; tests run both branches on any machine. */
  platform?: NodeJS.Platform
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
  // `holi` is prepended, never appended: an earlier `holi` on the inherited
  // PATH would otherwise win under a name the gate trusts. What follows the
  // inherited PATH is what a Dock-launched Holi lacks and every hook needs:
  // the usual tool directories, then Holi's own `node` as the last resort, so
  // a `node` the machine has always wins (`main/bridge/node-fallback.ts`).
  // The plugin commands come last of all, so a plugin adds a command but
  // never stands in for one the machine or Holi has.
  // One key, whatever case the inherited one had: a Windows environment copied
  // from an Explorer launch holds `Path`, and a second `PATH` beside it would
  // be read by some children and not by others.
  const platform = opts.platform ?? process.platform
  return withPath(
    env,
    [
      opts.binDir,
      toolPath(env, platform),
      opts.binDir ? nodeFallbackDir(opts.binDir, platform) : undefined,
      opts.commandsDir,
    ]
      .filter((dir): dir is string => !!dir)
      .join(delimiterFor(platform)),
    platform,
  )
}

/** `HOLI_CLAUDE_BIN` when it is set and runs, else `claude` as `resolveBin`
 *  finds it. */
export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.HOLI_CLAUDE_BIN
  if (override && isRunnable(override)) return override
  return resolveBin('claude', env)
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

/** @public exported for its test */
export interface RunOptions {
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  /** Successful `--bg` is the only launch whose descendants outlive the CLI. */
  retainDescendantsOnSuccess?: boolean
}

type ExecCallback = Parameters<typeof execProgram>[3]
type Ownership = NonNullable<Parameters<ExecCallback>[3]>
type RetainedLease = NonNullable<Extract<Ownership, { kind: 'settled' }>['lease']>

export interface ClaudeCliDeps {
  resolveBin?: () => string | null
  /** Legacy POSIX/string adapter. */
  run?: (bin: string, args: string[], opts: RunOptions) => Promise<string>
  execProgram?: typeof execProgram
  platform?: NodeJS.Platform
  log?: (msg: string) => void
}

type CommandFailure = { ok: false; message: string; error?: Error; cleanupUnconfirmed?: never }
type UnconfirmedFailure = {
  ok: false
  message: string
  cleanupUnconfirmed: true
  error: UnconfirmedOwnedProgramError
}
type UnconfirmedLaunchFailure = UnconfirmedFailure & {
  /** Receipt validation already joined this lease; retain its failure without retrying. */
  revokeAttempted?: true
}
type MissingProviderReceipt = {
  ok: false
  message: string
  cleanupUnconfirmed: true
  missingProviderReceipt: true
  error: Error
}
type ActionResult = { ok: true } | CommandFailure | UnconfirmedFailure
type StartResult =
  | { ok: true; id: string; lease?: RetainedLease }
  | CommandFailure
  | UnconfirmedLaunchFailure
  | MissingProviderReceipt

export interface ClaudeCli {
  /** Raw JSON from a successful, validated `claude agents --json` snapshot.
   *  Null for an ordinary command or format failure; rejects with
   *  UnconfirmedOwnedProgramError if native completion is unknown. Neither
   *  failure is an empty listing. */
  list(target: VaultCliTarget): Promise<string | null>
  stop(target: VaultCliTarget, id: string): Promise<ActionResult>
  respawn(target: VaultCliTarget, id: string): Promise<ActionResult>
  /** Remove a stopped session from Claude Code's list, conversation and all. */
  rm(target: VaultCliTarget, id: string): Promise<ActionResult>
  /** A new background session in the vault. With no prompt it waits for its
   *  first one; with a prompt, that prompt is its first turn. `model`,
   *  `allow` (Claude Code permission rules it may use without asking) are a
   *  scheduled run's or a Holi's; `deny` (rules it may never use, which beat
   *  an allow in any scope) a meeting scribe's; `appendSystemPrompt` (Claude
   *  Code's own flag) is a Holi's, who it is and its instructions. */
  startBg(target: VaultCliTarget, opts: StartBgOptions): Promise<StartResult>
  /** A background copy of a conversation, by Claude Code's full session id. */
  forkBg(target: VaultCliTarget, sessionId: string, name?: string): Promise<StartResult>
}

interface StartBgOptions {
  name?: string
  prompt?: string
  model?: string
  allow?: readonly string[]
  deny?: readonly string[]
  appendSystemPrompt?: string
  /** An absolute path to an MCP JSON config the session loads besides the
   *  vault's own (`--mcp-config`, additive). */
  mcpConfig?: string
}

/** The longest a session name is worth being: a row is narrow, and the source
 *  is usually the first line of a sentence someone selected. */
const MAX_NAME = 60

/**
 * A name fit for argv, or null. First line only, whitespace collapsed, capped:
 * a newline would split the argument in two.
 * @public exported for its test
 */
export function sessionName(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const line = raw.split('\n')[0] ?? ''
  const clean = line.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim()
  return clean === '' ? null : clean
}

const ANSI = /\x1b\[[0-9;]*m/g

/**
 * The id out of `backgrounded · <id> · <name>`, or null.
 * @public exported for its test
 */
export function parseBackgrounded(stdout: string, retained = false): string | null {
  const plain = stdout.replace(ANSI, '')
  if (!retained) return /^backgrounded\s+·\s+([0-9a-f]{8})\b/m.exec(plain)?.[1] ?? null
  // Only complete canonical receipts count for a retained handoff. Repeated
  // reports of one id are harmless, but no ordering can resolve a conflict.
  let id: string | null = null
  for (const [, candidate] of plain.matchAll(
    /^backgrounded[ \t]+·[ \t]+([0-9a-f]{8})[ \t]+·(?:[ \t]|$)/gm,
  )) {
    if (candidate === undefined) continue
    if (id !== null && id !== candidate) return null
    id = candidate
  }
  return id
}

/**
 * A prompt as the last arguments: after `--`, so one that starts with a dash
 * (`- tidy the list`) is the prompt and not an unknown option.
 */
function promptArgs(prompt: string | undefined): string[] {
  return prompt ? ['--', prompt] : []
}

/** The environment every `claude` Holi runs for a vault gets. It is also the
 *  vault's supervisor's, which its background sessions inherit. */
function cliEnv(base: NodeJS.ProcessEnv, target: VaultCliTarget): Record<string, string> {
  return buildAgentEnv(base, {
    configDir: target.configDir,
    binDir: target.binDir,
    commandsDir: join(target.root, PLUGIN_COMMANDS_DIR),
  })
}

/** The text for a machine without the binary: Windows gets its install command,
 *  and every other OS the text it has always had.
 * @public exported for its test */
export function notInstalledText(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'Claude CLI not found on PATH. Install it with `irm https://claude.ai/install.ps1 | iex` in PowerShell (or `npm install -g @anthropic-ai/claude-code`) and restart Holi.'
    : 'Claude CLI not found on PATH. Install it (https://claude.com/claude-code) and restart Holi.'
}

/** The binary when it is not on the machine. */
export const NOT_INSTALLED = notInstalledText()

/** What a terminal runs: `claude agents` (the list), `claude attach <id>`,
 *  a copy of a chat session's conversation (`--resume <id>
 *  --fork-session`), or Claude Code's own `/login` for the vault's config
 *  directory, which a chat session has no TUI to run. Null when the binary
 *  is not on this machine. */
export function terminalCommand(
  target: VaultCliTarget,
  attach?: string,
  resolveBin: () => string | null = () => resolveClaudeBin(),
  fork?: string,
  login?: boolean,
): TerminalCommand | null {
  const bin = resolveBin()
  if (bin === null) return null
  return {
    bin,
    args: login
      ? ['/login']
      : fork !== undefined
        ? ['--resume', fork, '--fork-session']
        : attach === undefined
          ? ['agents']
          : ['attach', attach],
    env: cliEnv(process.env, target),
  }
}

interface ExecOutcome {
  stdout: string
  stderr: string
  error: Error | null
  ownership?: Ownership
}

function defaultRun(
  launch: typeof execProgram,
  bin: string,
  args: string[],
  opts: RunOptions,
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const child = launch(
      bin,
      args,
      {
        ...opts,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr, ownership) => resolve({ error, stdout, stderr, ownership }),
    )
    // An open pipe makes --bg wait for stdin as part of the prompt.
    child.stdin?.end()
  })
}

export function createClaudeCli(deps: ClaudeCliDeps = {}): ClaudeCli {
  const log = deps.log ?? ((msg: string) => console.log(`[claude-cli] ${msg}`))
  const resolveBin = deps.resolveBin ?? (() => resolveClaudeBin())
  const windows = (deps.platform ?? process.platform) === 'win32'

  async function exec(
    target: VaultCliTarget,
    args: string[],
    timeoutMs: number,
    retainDescendantsOnSuccess = false,
  ) {
    const bin = resolveBin()
    if (bin === null) throw new Error(NOT_INSTALLED)
    const opts = {
      cwd: target.root,
      env: cliEnv(process.env, target),
      timeoutMs,
      ...(retainDescendantsOnSuccess ? { retainDescendantsOnSuccess: true } : {}),
    }
    const result: ExecOutcome = deps.run
      ? { stdout: await deps.run(bin, args, opts), stderr: '', error: null }
      : await defaultRun(deps.execProgram ?? execProgram, bin, args, opts)
    const { ownership, error, stderr } = result
    // The child controls stderr; it can explain a command failure but never
    // attest to completion, nor override the first command error or proof cause.
    const unconfirmed =
      ownership?.kind === 'unconfirmed'
        ? error instanceof UnconfirmedOwnedProgramError &&
          error.lease === ownership.lease &&
          error.cause === ownership.cause
          ? error
          : new UnconfirmedOwnedProgramError(ownership.cause, ownership.lease, error)
        : error instanceof UnconfirmedOwnedProgramError
          ? error
          : windows && !deps.run && ownership?.kind !== 'settled'
            ? new UnconfirmedOwnedProgramError(
                new Error('Windows Claude command did not report ownership completion'),
                undefined,
                error,
              )
            : undefined
    return { ...result, message: stderr || (error === null ? '' : String(error)), unconfirmed }
  }

  function failed(err: UnconfirmedOwnedProgramError): UnconfirmedFailure
  function failed(err: unknown): CommandFailure | UnconfirmedFailure
  function failed(err: unknown): CommandFailure | UnconfirmedFailure {
    const error = err instanceof Error ? err : new Error(String(err))
    return error instanceof UnconfirmedOwnedProgramError
      ? { ok: false, cleanupUnconfirmed: true, message: error.message, error }
      : { ok: false, message: error.message, error }
  }

  async function action(target: VaultCliTarget, args: string[]): Promise<ActionResult> {
    try {
      const result = await exec(target, args, ACTION_TIMEOUT_MS)
      if (result.unconfirmed) return failed(result.unconfirmed)
      if (result.error) return { ok: false, message: result.message, error: result.error }
      return { ok: true }
    } catch (err: unknown) {
      log(`${args[0]} failed: ${String(err)}`)
      return failed(err)
    }
  }

  async function start(target: VaultCliTarget, args: string[]): Promise<StartResult> {
    try {
      const result = await exec(target, args, ACTION_TIMEOUT_MS, true)
      // A proof failure can reach us before stdout finishes. Even a
      // complete-looking line cannot identify a session to act on here.
      if (result.unconfirmed) return failed(result.unconfirmed)
      const lease = result.ownership?.kind === 'settled' ? result.ownership.lease : undefined
      // Only a concrete handoff lease selects retained-id validation. Native
      // settlement (also reported on POSIX) doesn't describe provider stdout.
      const id =
        result.error === null ? parseBackgrounded(result.stdout, lease !== undefined) : null
      if (id !== null) return { ok: true, id, ...(lease === undefined ? {} : { lease }) }

      const error =
        result.error ??
        new Error(
          lease === undefined
            ? 'Claude Code did not report its background session id.'
            : 'Claude Code did not report an unambiguous background session id.',
        )
      if (lease !== undefined) {
        try {
          await lease.revoke()
        } catch (cause) {
          return {
            ...failed(new UnconfirmedOwnedProgramError(cause, lease, error)),
            revokeAttempted: true,
          }
        }
      } else if (result.error === null) {
        // The provider did not identify the session. No listing, name, or
        // missing PID can identify it in place of the receipt (legacy POSIX,
        // or a provider supervisor outside the just-drained native command).
        return {
          ok: false,
          cleanupUnconfirmed: true,
          missingProviderReceipt: true,
          error,
          message:
            'Cleanup unconfirmed: Claude Code started a session but did not report its id. Holi cannot safely confirm cleanup until native session ownership is known; identify the run in Claude Code before stopping it.',
        }
      }
      return { ok: false, message: result.error === null ? error.message : result.message, error }
    } catch (err: unknown) {
      log(`--bg failed: ${String(err)}`)
      return failed(err)
    }
  }

  class UnsupportedOption extends Error {}

  async function listing(target: VaultCliTarget, args: string[]): Promise<string> {
    const result = await exec(target, args, LIST_TIMEOUT_MS).catch((err: unknown) => {
      // The legacy string adapter can only report a command error by throwing.
      if (
        deps.run &&
        !(err instanceof UnconfirmedOwnedProgramError) &&
        /unknown option/i.test(String(err))
      )
        throw new UnsupportedOption(String(err))
      throw err
    })
    if (result.unconfirmed) throw result.unconfirmed
    if (result.ownership?.kind === 'settled' && result.ownership.lease !== undefined)
      throw new UnconfirmedOwnedProgramError(
        new Error('Claude listing unexpectedly retained native ownership'),
        result.ownership.lease,
        result.error,
      )
    if (result.error) {
      if (/unknown option/i.test(result.message)) throw new UnsupportedOption(result.message)
      throw result.error
    }
    // Draining the command says nothing about the validity of its rows.
    parseListing(result.stdout, target.root)
    return result.stdout
  }

  /** Set once this Claude Code has refused `--all`: it predates the flag,
   *  and its plain listing still carries the finished sessions. */
  let allRefused = false

  return {
    async list(target) {
      // Since 2.1.319 `--json` lists only active sessions and `--all` adds the
      // finished ones, which History is made of. An older Claude Code refuses
      // the flag as an unknown option; it listed them without it.
      try {
        if (!allRefused) {
          try {
            return await listing(target, ['agents', '--json', '--all'])
          } catch (err: unknown) {
            if (!(err instanceof UnsupportedOption)) throw err
            allRefused = true
          }
        }
        return await listing(target, ['agents', '--json'])
      } catch (err: unknown) {
        if (err instanceof UnconfirmedOwnedProgramError) throw err
        log(`listing failed: ${String(err)}`)
        return null
      }
    },
    stop: (target, id) => action(target, ['stop', id]),
    respawn: (target, id) => action(target, ['respawn', id]),
    rm: (target, id) => action(target, ['rm', id]),
    startBg(target, { name, prompt, model, allow = [], deny = [], appendSystemPrompt, mcpConfig }) {
      const label = sessionName(name)
      return start(target, [
        '--bg',
        ...(model === undefined ? [] : ['--model', model]),
        ...(appendSystemPrompt === undefined ? [] : ['--append-system-prompt', appendSystemPrompt]),
        // Variadic too: one `=` argument, so nothing after it is read as a
        // second config.
        ...(mcpConfig === undefined ? [] : [`--mcp-config=${mcpConfig}`]),
        // `--allowedTools` and `--disallowedTools` take any number of values,
        // so each rule is one `=` argument and a plain option always follows
        // to end the list: the name, which a list of rules therefore always
        // gets.
        ...allow.map((rule) => `--allowedTools=${rule}`),
        ...deny.map((rule) => `--disallowedTools=${rule}`),
        ...(label === null
          ? allow.length > 0 || deny.length > 0
            ? ['--name', 'Scheduled run']
            : []
          : ['--name', label]),
        ...promptArgs(prompt),
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
