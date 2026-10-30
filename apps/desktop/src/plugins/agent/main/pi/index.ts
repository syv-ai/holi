/**
 * Pi as a provider (`../provider.ts`): stock Pi, its core and its jobs. No
 * supervisor and no hooks, so Holi runs each session in a PTY of its own
 * (`../host/pty-sessions.ts`) and reads its turns off the terminal
 * (`../host/pty-signals.ts`); no status report, so no context meter.
 *
 * **Pi's setup stays the person's.** Its sign-in, models and settings stay
 * in `~/.pi/agent` (or `PI_CODING_AGENT_DIR`), which the person set up; Holi
 * adds no extension. A session reads it as Pi does, and the vault's
 * `AGENTS.md` itself. A job never reaches it: it gets a folder of its own.
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
 * may (`sandbox.ts`) and run only Node and Pi's script, with an environment
 * of `HOME`, `PATH`, `LANG`, the model keys and the proxy and certificate
 * variables alone. Anywhere else no job runs: there is no boundary Holi can
 * put around it.
 *
 * **A job's Pi folder is its own** (`PI_CODING_AGENT_DIR`, in its state
 * folder): Holi copies the person's settings, models and global
 * instructions into it, and an `auth.json` with the sign-in of the one
 * provider the job runs on (the job's model, else Pi's default; with neither
 * known it does not run), passed to Pi as `--provider` and `--model`. A
 * token Pi refreshed in the job goes back into the person's `auth.json`
 * after the turn, that entry alone, under Pi's lock (`returnSignIn`). No
 * folder a job reads or writes may be the person's home, Pi's own folder,
 * or one above either.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
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

/** `HOLI_PI_BIN` when set and runnable, else `pi` on `PATH`. */
function resolvePiBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.HOLI_PI_BIN
  return override !== undefined && override !== '' && executable(override)
    ? override
    : resolveBin('pi', env)
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
 * own folder, everything the person's setup could add turned off, no
 * network at startup (its catalogue refresh would write), the file tools
 * alone, and the provider and model it runs on.
 * @public exported for its test
 */
export function jobArgs({ state, resume }: JobRun, pick?: ModelPick): string[] {
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
    '--offline',
    '--tools',
    'read,edit,write',
    ...(pick === undefined ? [] : ['--provider', pick.provider, '--model', pick.model]),
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

/** How a machine behind a proxy, or one that trusts a certificate of its
 *  own, reaches the model: kept too. */
const NETWORK_VARS = [
  'NODE_EXTRA_CA_CERTS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
]

/**
 * A job's environment: where home is, a `PATH` of the runtime and the
 * system's tools, the language, a temporary folder in the job's own, Pi's
 * folder for the job, the model keys and the way to the network. Nothing
 * else of Holi's or the person's.
 * @public exported for its test
 */
export function jobEnv(
  base: NodeJS.ProcessEnv,
  { runtimeBin, state, agentDir }: { runtimeBin: string | null; state: string; agentDir: string },
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: base.HOME ?? homedir(),
    PATH: [...(runtimeBin === null ? [] : [runtimeBin]), '/usr/bin', '/bin'].join(':'),
    LANG: base.LANG ?? 'en_US.UTF-8',
    TMPDIR: join(state, 'tmp'),
    PI_CODING_AGENT_DIR: agentDir,
  }
  for (const key of [...KEY_VARS, ...NETWORK_VARS]) {
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

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The person's Pi folder: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
function personAgentDir(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? homedir()
  const dir = env.PI_CODING_AGENT_DIR
  if (dir === undefined || dir === '') return join(home, '.pi', 'agent')
  return dir === '~' ? home : dir.startsWith('~/') ? join(home, dir.slice(2)) : dir
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

/** The start of `file`, or null when it cannot be read. */
function headOf(file: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(4096)
    return buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, 0))
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** A script Node runs (`#!/usr/bin/env node`)? */
const isNodeScript = (head: string | null): boolean =>
  head !== null && head.startsWith('#!') && /\bnode\b/.test(head.split('\n', 1)[0] ?? '')

/**
 * The launcher Pi's own installer (`pi.dev/install.sh`) writes at
 * `<agent>/bin/pi`: a `/bin/sh` script that runs
 * `<agent>/install/releases/<current-version>/node_modules/.bin/pi`, with the
 * Node the installer put in `${XDG_DATA_HOME:-~/.local/share}/pi-node`
 * first on `PATH` when there is one.
 */
const isManagedLauncher = (head: string): boolean =>
  head.startsWith('#!/bin/sh') &&
  head.includes('pi_release_bin=$pi_release_dir/node_modules/.bin/pi') &&
  head.includes('/install/current-version')

/** The installer's rule for a release's name (`write_managed_install_launcher`). */
const RELEASE = /^[0-9A-Za-z._+-]+$/

/** What a job runs: the Node that runs Pi, or null for a program of its own,
 *  and Pi's script. Every path real. */
interface PiProgram {
  runtime: string | null
  script: string
}

/**
 * The program behind `pi`: a Node script and the Node on `PATH`, Pi's own
 * launcher followed to the release it names and the Node it runs that on, or
 * a binary of its own. Anything else is refused: Holi cannot tell what it
 * would run, so it cannot name it in the sandbox.
 * @public exported for its test
 */
export function piProgram(pi: string, env: NodeJS.ProcessEnv, node: string | null): PiProgram {
  const target = real(pi)
  const head = headOf(target)
  if (head === null) throw new Error(`Holi could not read Pi at ${pi}.`)
  if (!head.startsWith('#!')) return { runtime: null, script: target }
  let script = target
  let runtime = node === null ? null : real(node)
  if (isManagedLauncher(head)) {
    const agent = dirname(dirname(target))
    const unfollowed = new Error(
      `Holi could not tell which Pi release the launcher at ${pi} runs, so the job did not start. Run pi once in a terminal, then try again.`,
    )
    let version: string
    try {
      version = readFileSync(join(agent, 'install', 'current-version'), 'utf8').split('\n', 1)[0]!
    } catch {
      throw unfollowed
    }
    if (!RELEASE.test(version) || version === '.' || version === '..') throw unfollowed
    const release = join(agent, 'install', 'releases', version, 'node_modules', '.bin', 'pi')
    if (!executable(release)) throw unfollowed
    script = real(release)
    const share =
      env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME !== ''
        ? env.XDG_DATA_HOME
        : join(env.HOME ?? homedir(), '.local', 'share')
    const own = join(share, 'pi-node', 'current', 'bin', 'node')
    if (executable(own)) runtime = real(own)
  }
  if (!isNodeScript(script === target ? head : headOf(script))) {
    throw new Error(
      `Pi at ${pi} is a script Holi cannot follow to the program it runs, so the job did not start.`,
    )
  }
  if (runtime === null) {
    throw new Error('Pi runs on Node, and Holi found no node to run it with.')
  }
  return { runtime, script }
}

/** Is `dir` the folder `held` or one of the folders above it? */
const holds = (dir: string, held: string): boolean =>
  dir === held || held.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`)

/** A folder a job may read or write must never open the person's home or
 *  Pi's own folder (its sign-in and every session) to it. */
function guardFolders(folders: readonly string[], home: string, agentDir: string): void {
  for (const dir of folders) {
    const what = holds(dir, home)
      ? 'your home folder'
      : holds(dir, agentDir)
        ? "Pi's own folder, with its sign-in and sessions"
        : null
    if (what !== null) {
      throw new Error(
        `The job would have reached ${dir}, which holds ${what}, so it did not start.`,
      )
    }
  }
}

/** The provider and model a job runs on. */
interface ModelPick {
  provider: string
  model: string
}

/**
 * The provider and model a job runs on: the job's own model (`provider/id`,
 * or an id of the provider Pi defaults to), else Pi's default. A string says
 * why there is none to tell: the job is given one provider's sign-in, so it
 * must be known before it runs.
 * @public exported for its test
 */
export function pickModel(settings: unknown, model: string | undefined): ModelPick | string {
  const s = record(settings) ?? {}
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
  const provider = text(s['defaultProvider'])
  if (model !== undefined) {
    const slash = model.indexOf('/')
    if (slash > 0) return { provider: model.slice(0, slash), model: model.slice(slash + 1) }
    return provider === null
      ? `Holi could not tell which of Pi's providers runs ${model}, so the job did not start. Choose a default model in Pi (/model), then try again.`
      : { provider, model }
  }
  const fallback = text(s['defaultModel'])
  return provider === null || fallback === null
    ? 'Pi has no default model, so Holi could not tell which sign-in the job needs. Choose one in Pi (/model), then try again.'
    : { provider, model: fallback }
}

/** Pi's files a job's own folder gets copies of: its settings, its models
 *  and their catalogue, and its global instructions. */
const COPIED = [
  'settings.json',
  'models.json',
  'models-store.json',
  'AGENTS.md',
  'AGENTS.override.md',
  'CLAUDE.md',
  'SYSTEM.md',
  'APPEND_SYSTEM.md',
]

/** One provider's sign-in, handed to a job and taken back after. */
interface SignIn {
  /** The person's `auth.json`, as Pi names it (its lock is beside it). */
  file: string
  /** The job's copy. */
  copy: string
  provider: string
  /** The entry as it was handed over, as JSON; undefined for none. */
  before: string | undefined
}

/**
 * Pi's own folder for one job (`PI_CODING_AGENT_DIR`), filled by Holi
 * outside the sandbox: copies of the person's settings, models and global
 * instructions, and an `auth.json` with the sign-in of the one provider the
 * job runs on. A symlinked file is read through to what it names. The job
 * reads and writes this folder alone, never the person's.
 */
function jobAgentDir(
  personDir: string,
  dir: string,
  model: string | undefined,
): { pick: ModelPick; signIn: SignIn } {
  const read = (name: string): string | null => {
    try {
      return readFileSync(join(personDir, name), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error(`Holi could not read Pi's ${name}, so the job did not start.`)
    }
  }
  const json = (name: string, text: string | null): unknown => {
    if (text === null) return {}
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error(`Pi's ${name} is not JSON Holi can read, so the job did not start.`)
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let settings: string | null = null
  for (const name of COPIED) {
    const text = read(name)
    if (name === 'settings.json') settings = text
    if (text === null) rmSync(join(dir, name), { force: true })
    else writeFileSync(join(dir, name), text, { mode: 0o600 })
  }
  const pick = pickModel(json('settings.json', settings), model)
  if (typeof pick === 'string') throw new Error(pick)
  const auth = record(json('auth.json', read('auth.json'))) ?? {}
  const entry = auth[pick.provider]
  const copy = join(dir, 'auth.json')
  writeFileSync(
    copy,
    JSON.stringify(entry === undefined ? {} : { [pick.provider]: entry }, null, 2),
    { mode: 0o600 },
  )
  return {
    pick,
    signIn: {
      file: join(personDir, 'auth.json'),
      copy,
      provider: pick.provider,
      before: entry === undefined ? undefined : JSON.stringify(entry),
    },
  }
}

/** Hold Pi's lock on `file` while `fn` runs: the `<file>.lock` folder Pi
 *  makes (`proper-lockfile`), taken over once it is older than Pi's own
 *  stale limit. */
async function withPiLock(
  file: string,
  fn: () => Promise<void>,
  { staleMs = 30_000, waitMs = 10_000 } = {},
): Promise<void> {
  const lock = `${file}.lock`
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const held = await stat(lock).catch(() => null)
      if (held !== null && Date.now() - held.mtimeMs > staleMs) {
        await rm(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error(`Pi's ${basename(file)} stayed locked.`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  try {
    await fn()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

/**
 * After a turn: the job's sign-in, when Pi refreshed it, goes back into the
 * person's `auth.json`, that provider's entry alone, under Pi's lock. Only a
 * credential of the kind it was, and only while the person's is still the
 * one handed over: one they changed meanwhile is newer and stands.
 * @public exported for its test
 */
export async function returnSignIn(signIn: SignIn): Promise<void> {
  const { file, copy, provider, before } = signIn
  if (before === undefined) return
  let after: unknown
  try {
    after = record(JSON.parse(await readFile(copy, 'utf8')))?.[provider]
  } catch {
    return
  }
  if (after === undefined || JSON.stringify(after) === before) return
  const kind = (v: unknown): unknown => record(v)?.['type']
  if (record(after) === null || kind(after) !== kind(JSON.parse(before))) return
  await withPiLock(file, async () => {
    const target = real(file)
    const current = record(JSON.parse(await readFile(target, 'utf8')))
    if (current === null || JSON.stringify(current[provider]) !== before) return
    current[provider] = after
    const next = join(dirname(target), `.${basename(target)}.holi-${process.pid}`)
    await writeFile(next, JSON.stringify(current, null, 2), { mode: 0o600 })
    await rename(next, target)
  })
}

/** The job's own Pi folder, in its state folder. */
const AGENT_DIR = 'pi-agent'

/**
 * What one turn of a job runs: Pi under `sandbox-exec`, its runtime named
 * rather than found on `PATH`, with a profile of the job's folders, and Pi's
 * own folder for the job, made now. `signIn` is what to take back after.
 * @public exported for its test
 */
export function jobCommand(
  pi: string,
  run: JobRun,
  {
    env: base = process.env,
    node = resolveBin('node', base),
  }: { env?: NodeJS.ProcessEnv; node?: string | null } = {},
): { command: TerminalCommand; signIn: SignIn } {
  const { runtime, script } = piProgram(pi, base, node)
  const home = real(base.HOME ?? homedir())
  const personDir = real(personAgentDir(base))
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
  guardFolders([...read.map((r) => r.dir), ...writes, state], home, personDir)
  const ca = base.NODE_EXTRA_CA_CERTS
  const profile = sandboxProfile({
    exec: runtime === null ? [script] : [runtime, script],
    read,
    readFiles: ca === undefined || ca === '' ? [] : [real(ca)],
    write: [...writes, state],
  })
  const agentDir = join(state, AGENT_DIR)
  const { pick, signIn } = jobAgentDir(personDir, agentDir, run.model)
  return {
    command: {
      bin: SANDBOX_EXEC,
      args: [
        '-p',
        profile,
        ...(runtime === null ? [script] : [runtime, script]),
        ...jobArgs(run, pick),
      ],
      env: jobEnv(base, {
        runtimeBin: runtime === null ? null : dirname(runtime),
        state,
        agentDir,
      }),
    },
    signIn,
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
  // Each running turn's sign-in, by its state folder, to take back after.
  const signIns = new Map<string, SignIn>()
  return {
    id: 'pi',
    label: 'Pi',
    notInstalled: NOT_INSTALLED,
    installed: () => bin() !== null,
    namesConversation: true,
    // Pi keeps its own home; Holi has nothing to provision in it.
    configure: async () => ({ dir: personAgentDir(process.env) }),
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
          if (path === null) return null
          const { command, signIn } = jobCommand(path, run)
          signIns.set(run.state, signIn)
          return command
        },
        async ended(run) {
          const signIn = signIns.get(run.state)
          signIns.delete(run.state)
          if (signIn !== undefined) await returnSignIn(signIn)
        },
        event: readJobEvent,
        input: { start: jobInput, abort: ABORT },
      },
    },
  }
}
