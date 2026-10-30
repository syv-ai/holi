/**
 * Pi as a provider (`../provider.ts`): stock Pi, its core and its jobs. No
 * supervisor and no hooks, so Holi runs each session in a PTY of its own
 * (`../host/pty-sessions.ts`) and reads its turns off the terminal
 * (`../host/pty-signals.ts`); no status report, so no context meter.
 *
 * **Nothing of the machine's Pi is touched.** Its sign-in, models and
 * settings stay in `~/.pi/agent` (or `PI_CODING_AGENT_DIR`), which the person
 * set up; Holi adds no extension and changes no file of Pi's. It reads the
 * vault's `AGENTS.md` itself.
 *
 * **A session's conversation is named by Holi** (`--session-id`, a UUID
 * Holi chose, which opens that id in the vault or creates it), so a session
 * is reopenable from its start, under the same flag, and a copy is
 * `--fork <id>` under a new UUID. Every id Holi passes Pi, its own job
 * sessions' (`uuidv7`) included, is checked as a UUID first.
 * Nothing of Pi's files is read.
 *
 * **Jobs** are `pi --mode rpc` (`../host/jobs.ts`): a `get_state` for the
 * session's id and a `prompt` on its input, its events read until
 * `agent_settled`, then its input closed, which ends it. A follow-up is a new
 * process on the same session (`--session <id>`), from a session folder of
 * the job's own. Extensions, skills, prompt templates, themes, MCP and the
 * project's own `.pi/` are off, and its tools are `read`, `edit` and `write`:
 * no shell, so no tool reaches the network. Stock Pi has no sandbox and asks
 * nothing before a tool runs, so on macOS the process runs under
 * `sandbox-exec` with a profile that lets it read and write only what the job
 * may (`sandbox.ts`), with an environment of `HOME`, `PATH`, `LANG` and the
 * model keys alone. Anywhere else no job runs: there is no boundary Holi can
 * put around it.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { resolveBin } from '../../../../main/plugin-api'
import { buildAgentEnv } from '../claude/cli'
import { CONVERSATION_ID } from '../host/pty-sessions'
import type { AgentProvider, JobEvent, JobRun, TerminalCommand, TerminalOpts } from '../provider'
import { sandboxProfile, vaultHidden, type SandboxSpec } from './sandbox'

const NOT_INSTALLED =
  'Pi not found on PATH. Install it (npm install -g @earendil-works/pi-coding-agent) and restart Holi.'

/** Why a Pi job does not run off macOS. */
const NO_BOUNDARY =
  'Pi runs every tool without asking, and Holi has no safe boundary to put around it on this platform, so the run did not start.'

const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/** `HOLI_PI_BIN` when set, else `pi` on `PATH`. */
function resolvePiBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.HOLI_PI_BIN
  if (override) {
    try {
      accessSync(override, constants.X_OK)
      return override
    } catch {
      // Not runnable: fall back to the one on PATH.
    }
  }
  return resolveBin('pi', env)
}

/** A Pi session id Holi passes on: a UUID, the shape Holi names a new
 *  conversation with and Pi's own (`uuidv7`) have, so it is never read as a
 *  flag. Anything else is left out. */
const sessionId = (id: string | undefined): string | undefined =>
  id !== undefined && CONVERSATION_ID.test(id) ? id : undefined

/**
 * What a terminal runs: a new conversation under the UUID Holi chose for it,
 * that conversation again, Pi's own picker, or a copy of one under a new
 * UUID. Each id a UUID, and the ask after `--`, so one that starts with `-`
 * is still the ask.
 * @public exported for its test
 */
export function terminalArgs(opts: TerminalOpts): string[] {
  const { prompt } = opts
  const named = sessionId(opts.conversation)
  const fork = sessionId(opts.fork)
  const resume = sessionId(opts.resume)
  const head =
    opts.resume === 'pick'
      ? ['--resume']
      : fork !== undefined
        ? ['--fork', fork, ...(named === undefined ? [] : ['--session-id', named])]
        : resume !== undefined
          ? ['--session-id', resume]
          : named === undefined
            ? []
            : ['--session-id', named]
  return [...head, ...(prompt === undefined || prompt.trim() === '' ? [] : ['--', prompt])]
}

/**
 * Pi's arguments for one turn of a job: RPC mode, its session in the job's
 * own folder, everything the person's setup could add turned off, and the
 * file tools alone.
 * @public exported for its test
 */
export function jobArgs({ state, model, resume }: JobRun): string[] {
  const session = sessionId(resume)
  return [
    '--mode',
    'rpc',
    '--session-dir',
    join(state, 'sessions'),
    ...(session === undefined ? [] : ['--session', session]),
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-mcp',
    '--no-approve',
    '--tools',
    'read,edit,write',
    ...(model === undefined ? [] : ['--model', model]),
  ]
}

/** The ids of a job's two commands, which their responses repeat. */
const STATE_ID = 'holi-state'
const PROMPT_ID = 'holi-prompt'

/**
 * What a turn writes on Pi's input: its session's id asked first, then the
 * prompt.
 * @public exported for its test
 */
export const jobInput = (run: JobRun): string[] => [
  JSON.stringify({ id: STATE_ID, type: 'get_state' }),
  JSON.stringify({ id: PROMPT_ID, type: 'prompt', message: run.prompt }),
]

/** Asks the run under way to stop. */
const ABORT = JSON.stringify({ type: 'abort' })

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** A reply's tokens, all of them, cached ones included. Null when it says
 *  none. */
function tokensOf(message: Record<string, unknown>): number | null {
  const usage = record(message['usage'])
  if (usage === null) return null
  const n = (key: string): number => {
    const v = usage[key]
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
  }
  const total = n('totalTokens') || n('input') + n('output') + n('cacheRead') + n('cacheWrite')
  return total > 0 ? total : null
}

const clip = (text: string): string => {
  const line = text.trim().split('\n', 1)[0]?.trim() ?? ''
  return line.length > 300 ? `${line.slice(0, 299)}…` : line
}

/**
 * One line of Pi's RPC output: its session's id, a command it refused, each
 * reply's usage and error, and the run settling. Anything else (deltas, tool
 * events) is nothing to the host.
 * @public exported for its test
 */
export function readJobEvent(line: string): JobEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  const r = record(parsed)
  if (r === null) return null
  switch (r['type']) {
    case 'response': {
      if (r['success'] === false) {
        const error = typeof r['error'] === 'string' ? clip(r['error']) : ''
        return { kind: 'error', message: error === '' ? 'Pi refused the job.' : error }
      }
      const data = record(r['data'])
      if (r['id'] === STATE_ID) {
        const id = data?.['sessionId']
        if (typeof id !== 'string' || sessionId(id) === undefined) return null
        const model = record(data?.['model'])?.['id']
        return typeof model === 'string' && model !== 'unknown' && model.length <= 120
          ? { kind: 'thread', id, model }
          : { kind: 'thread', id }
      }
      if (r['id'] === PROMPT_ID) {
        // Taken without a run: nothing will settle.
        return data?.['disposition'] === 'started'
          ? { kind: 'turn-started' }
          : { kind: 'error', message: 'Pi took the prompt but started no run.' }
      }
      return null
    }
    case 'message_end': {
      const message = record(r['message'])
      if (message === null || message['role'] !== 'assistant') return null
      const tokens = tokensOf(message)
      const failed = message['stopReason'] === 'error'
      const why = typeof message['errorMessage'] === 'string' ? clip(message['errorMessage']) : ''
      return {
        kind: 'reply',
        ...(tokens === null ? {} : { tokens }),
        ...(failed ? { error: why === '' ? 'Pi reported an error.' : why } : {}),
      }
    }
    case 'agent_settled':
      return { kind: 'settled', aborted: r['aborted'] === true }
    default:
      return null
  }
}

/** The environment variables a model's key may be in, which a job keeps.
 *  Every other variable is left out. */
const KEY_VARS = [
  'AI_GATEWAY_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'AZURE_OPENAI_API_KEY',
  'CEREBRAS_API_KEY',
  'DEEPSEEK_API_KEY',
  'FIREWORKS_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_CLOUD_API_KEY',
  'GROQ_API_KEY',
  'HF_TOKEN',
  'KIMI_API_KEY',
  'MISTRAL_API_KEY',
  'MOONSHOT_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'TOGETHER_API_KEY',
  'XAI_API_KEY',
  'ZAI_API_KEY',
]

/**
 * A job's environment: where home is, a `PATH` of the runtime and the
 * system's tools, the language, a temporary folder in the job's own, Pi's
 * folder when it was moved, and the model keys. Nothing else of Holi's or
 * the person's.
 * @public exported for its test
 */
export function jobEnv(
  base: NodeJS.ProcessEnv,
  { runtimeBin, state }: { runtimeBin: string | null; state: string },
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: base.HOME ?? homedir(),
    PATH: [...(runtimeBin === null ? [] : [runtimeBin]), '/usr/bin', '/bin'].join(':'),
    LANG: base.LANG ?? 'en_US.UTF-8',
    TMPDIR: join(state, 'tmp'),
  }
  for (const key of ['PI_CODING_AGENT_DIR', ...KEY_VARS]) {
    const value = base[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  return env
}

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * The folder Pi's code and its packages are read from: the store of a pnpm
 * install, the outermost `node_modules` of an npm one, else the folder
 * above the binary.
 * @public exported for its test
 */
export function installRoot(script: string): string {
  const pnpm = script.indexOf(`${sep}.pnpm${sep}`)
  if (pnpm !== -1) return script.slice(0, pnpm + `${sep}.pnpm`.length)
  const modules = script.indexOf(`${sep}node_modules${sep}`)
  if (modules !== -1) return script.slice(0, modules + `${sep}node_modules`.length)
  return dirname(dirname(script))
}

/** Is `file` a script Node runs (`#!/usr/bin/env node`)? */
function isNodeScript(file: string): boolean {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(200)
    const head = buf.toString('utf8', 0, readSync(fd, buf, 0, 200, 0))
    return head.startsWith('#!') && /\bnode\b/.test(head.split('\n', 1)[0] ?? '')
  } catch {
    return false
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** Pi's files a job reads (its sign-in, models, settings and global
 *  instructions), and the two its sign-in writes: a token refreshed, under
 *  the lock Pi takes on it. */
function agentFiles(agentDir: string): { read: string[]; write: string[] } {
  return {
    read: [
      'settings.json',
      'models.json',
      'models-store.json',
      'AGENTS.md',
      'AGENTS.override.md',
      'CLAUDE.md',
      'SYSTEM.md',
      'APPEND_SYSTEM.md',
    ].map((f) => join(agentDir, f)),
    write: [join(agentDir, 'auth.json'), join(agentDir, 'auth.json.lock')],
  }
}

/**
 * What one turn of a job runs: Pi under `sandbox-exec`, its runtime named
 * rather than found on `PATH`, with a profile of the job's folders.
 * @public exported for its test
 */
export function jobCommand(
  pi: string,
  run: JobRun,
  {
    env: base = process.env,
    node = resolveBin('node', base),
  }: { env?: NodeJS.ProcessEnv; node?: string | null } = {},
): TerminalCommand {
  const script = real(pi)
  const runtime = isNodeScript(script) && node !== null ? real(node) : null
  const agentDir = real(base.PI_CODING_AGENT_DIR ?? join(base.HOME ?? homedir(), '.pi', 'agent'))
  const files = agentFiles(agentDir)
  const state = real(run.state)
  const cwd = real(run.cwd)
  const writes = run.readOnly === true ? [] : [cwd, ...(run.writable ?? []).map(real)]
  const read: SandboxSpec['read'][number][] = [
    { dir: installRoot(script) },
    ...(runtime === null ? [] : [{ dir: dirname(dirname(runtime)) }]),
  ]
  if (run.vault !== undefined) {
    const vault = real(run.vault)
    read.push({ dir: vault, hidden: vaultHidden(vault) })
  } else read.push({ dir: cwd })
  const profile = sandboxProfile({
    read,
    readFiles: files.read,
    write: [...writes, state, ...files.write],
  })
  const args = jobArgs(run)
  return {
    bin: SANDBOX_EXEC,
    args: ['-p', profile, ...(runtime === null ? [script] : [runtime, script]), ...args],
    env: jobEnv(base, { runtimeBin: runtime === null ? null : dirname(runtime), state }),
  }
}

export interface PiProviderDeps {
  resolveBin?: () => string | null
  /** The platform jobs run on: `darwin` alone has the boundary. */
  platform?: NodeJS.Platform
}

export function piProvider(deps: PiProviderDeps = {}): AgentProvider {
  const bin = deps.resolveBin ?? (() => resolvePiBin())
  const platform = deps.platform ?? process.platform
  return {
    id: 'pi',
    label: 'Pi',
    notInstalled: NOT_INSTALLED,
    installed: () => bin() !== null,
    namesConversation: true,
    // Pi keeps its own home; Holi has nothing to provision in it.
    configure: async () => ({
      dir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'),
    }),
    terminal(target, opts = {}) {
      const path = bin()
      if (path === null) return null
      return {
        bin: path,
        args: terminalArgs(opts),
        env: buildAgentEnv(process.env, { binDir: target.binDir }),
      }
    },
    capabilities: {
      jobs: {
        unavailable: () => (platform === 'darwin' && existsSync(SANDBOX_EXEC) ? null : NO_BOUNDARY),
        command(run) {
          const path = bin()
          return path === null ? null : jobCommand(path, run)
        },
        event: readJobEvent,
        input: { start: jobInput, abort: ABORT },
      },
    },
  }
}
