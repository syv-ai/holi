/**
 * Codex as a provider (`../provider.ts`): the core, and turn ends from its
 * `notify` hook. No supervisor, so Holi runs each session in a PTY of its own
 * (`../host/pty-sessions.ts`); no status report, so no context meter.
 *
 * **Nothing of the machine's Codex is touched.** Its sign-in and config stay
 * in `~/.codex`, which the person set up; Holi adds its hook for the one run
 * with `-c notify=…`, a command-line override that outranks the config file
 * and is written nowhere. It reads the vault's `AGENTS.md` itself.
 *
 * The hook is one inline shell command, like Claude Code's status line: Codex
 * runs it at each turn's end with the turn's JSON as its last argument, and it
 * posts that to the bridge, found through the vault's `bridge.local.env` and
 * keyed by Holi's id for the session (`HOLI_AGENT_SESSION`, which the PTY's
 * environment carries to Codex and on to its hook). The turn's start comes
 * from the terminal (`../host/pty-signals.ts`).
 *
 * **Interactive sessions** also get `tui.notifications` for approvals, which
 * Codex prints as OSC 9 desktop notifications: the terminal
 * stream reads one during a turn as a question for the person
 * (`../host/pty-signals.ts`), so an approval prompt shows as needs-you.
 *
 * **Jobs** are `codex exec --json` (`../host/jobs.ts`), in a scratch folder
 * Holi made or in the vault with named folders writable: the workspace-write
 * sandbox with no network (read-only when nothing may be written) and no web
 * search, and an approval policy of never, so a step the sandbox refuses
 * fails rather than waiting on a person nobody is. The sandbox keeps its
 * writes to the folders it may write; it can still read the disk, so what
 * bounds a scratch job is what Holi copies back. Its JSONL events say how
 * the run went, and `codex exec … resume -- <thread>` is a follow-up turn on
 * the same thread.
 *
 * **A fenced session** (`TerminalOpts.fence`) is the TUI in a scratch folder
 * Holi made (`../host/fenced.ts`), under the same sandbox and with the same
 * tools off, but with Codex's interactive approvals: the person watches it
 * and answers in its terminal. What it wrote is copied back at each turn's
 * end, which `notify` reports.
 *
 * **Neither runs on the person's `~/.codex`.** Each gets a Codex folder of
 * its own in its state folder (`home.ts`), with their sign-in and model
 * settings and none of their MCP servers, plugins, skills or hooks: a
 * command-line override cannot take those away. A token Codex refreshed
 * there goes back into their `auth.json` once the process exits
 * (`release`).
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { resolveBin, shellReadBridgeEnv } from '../../../../main/plugin-api'
import { buildAgentEnv } from '../claude/cli'
import { personCodexHome, prepareCodexHome, releaseCodexHome } from './home'
import { CONVERSATION_ID, PTY_SESSION_ID } from '../host/pty-sessions'
import type { AgentProvider, JobEvent, JobRun, RouteServer, TurnRouteDeps } from '../provider'

/**
 * The variable that names the session to its hook.
 * @public exported for its test
 */
export const SESSION_ENV = 'HOLI_AGENT_SESSION'

const NOT_INSTALLED =
  'Codex CLI not found on PATH. Install it (https://developers.openai.com/codex/cli) and restart Holi.'

/** `HOLI_CODEX_BIN` when set, else `codex` on `PATH`. */
export function resolveCodexBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.HOLI_CODEX_BIN
  if (override) {
    try {
      accessSync(override, constants.X_OK)
      return override
    } catch {
      // Not runnable: fall back to the one on PATH.
    }
  }
  return resolveBin('codex', env)
}

/** The hook: `sh -c <this> holi-notify <json>`, so the JSON is `$1`. Quiet,
 *  bounded, and a no-op outside a Holi session or with Holi closed.
 * @public exported for its test
 */
export const NOTIFY_SCRIPT = [
  `case "\${${SESSION_ENV}:-}" in p*) ;; *) exit 0 ;; esac`,
  `case "$${SESSION_ENV}" in *[!0-9a-fp]*) exit 0 ;; esac`,
  ...shellReadBridgeEnv(['HOLI_BRIDGE_PORT', 'HOLI_BRIDGE_TOKEN']),
  `if [ -n "$HOLI_BRIDGE_PORT" ] && [ -n "$HOLI_BRIDGE_TOKEN" ]; then printf '%s' "$1" | curl -s -m 2 -o /dev/null -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:$HOLI_BRIDGE_PORT/codex/turn-end?t=$HOLI_BRIDGE_TOKEN&session=$${SESSION_ENV}" >/dev/null 2>&1; fi`,
  'true',
].join('; ')

/** The `-c` override that installs the hook: a TOML array, whose strings
 *  JSON's quoting writes correctly.
 * @public exported for its test
 */
export const notifyOverride = (): string =>
  `notify=${JSON.stringify(['sh', '-c', NOTIFY_SCRIPT, 'holi-notify'])}`

/** What Codex's turn JSON says about the session: its first ask and its
 *  thread. Another program's output, so anything unrecognised is nothing.
 * @public exported for its test
 */
export function readTurn(body: string): { name?: string; conversationId?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object') return {}
  const r = parsed as Record<string, unknown>
  const inputs = r['input-messages']
  const first = Array.isArray(inputs) ? inputs.find((m) => typeof m === 'string') : undefined
  const thread = r['thread-id']
  return {
    ...(typeof first === 'string' && first.trim() !== '' ? { name: first } : {}),
    ...(typeof thread === 'string' && CONVERSATION_ID.test(thread)
      ? { conversationId: thread }
      : {}),
  }
}

/**
 * Serve `/codex/turn-end`. Every answer is empty. Returns the undo.
 * @public exported for its test
 */
export function registerCodexRoutes(server: RouteServer, deps: TurnRouteDeps): () => void {
  return server.route('/codex/turn-end', {
    body: 'text',
    handle(remote, query, body) {
      const session = query.get('session') ?? ''
      if (PTY_SESSION_ID.test(session)) {
        deps.onConversation?.(remote, session, readTurn(body))
        deps.onTurn(remote, session, false, null)
      }
      return { status: 204 }
    },
  })
}

/** The `-c` override that turns on the TUI's desktop notification for an
 * approval it waits on: OSC 9 in the terminal stream. Not a turn's end, which
 * the `notify` hook reports already, and which would read as a question.
 * @public exported for its test
 */
export const NOTIFICATIONS_OVERRIDE = 'tui.notifications=["approval-requested"]'

/** The conversation to pick up, checked again where it goes on the command
 *  line: never anything but a UUID, so never a flag. */
function conversation(id: string): string {
  if (!CONVERSATION_ID.test(id)) throw new Error('Not a Codex conversation id.')
  return id
}

/**
 * What runs one turn of a job: `codex exec` in `cwd`, never asking, with no
 * network, writing `cwd` and `writable` alone (nothing when `readOnly`). A
 * `resume` is a follow-up on that thread.
 *
 * Every option goes before `resume`, as the usage line of `codex exec` has it
 * (`codex exec [OPTIONS] <COMMAND> [ARGS]`, codex-rs/exec/src/cli.rs in
 * openai/codex): `-C` and `--sandbox` are options of `codex exec` itself, not
 * global ones, so after `resume` they would not parse, and `codex exec resume`
 * builds its thread's sandbox, approval policy and folder from them
 * (`thread_resume_params_from_config`, codex-rs/exec/src/lib.rs). `-c`,
 * `--json`, `-m` and `--skip-git-repo-check` are global and would parse on
 * either side. Then `--`, so the thread and the prompt are only ever those.
 *
 * An unattended run must have no tools outside the sandbox: it runs on a
 * Codex folder with no MCP servers (`home.ts`), and web search is off, under
 * both the key current Codex reads (`web_search`) and the older
 * `tools.web_search`.
 * @public exported for its test
 */
export function jobArgs({
  cwd,
  prompt,
  model,
  writable = [],
  readOnly = false,
  resume,
  state,
}: Omit<JobRun, 'state' | 'vault'> & { state?: string }): string[] {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C',
    cwd,
    // Its last message in the job's state folder, which also puts that
    // folder on its command line: what Holi's startup sweep knows a job
    // that outlived a crash by (`../host/jobs.ts`).
    ...(state === undefined ? [] : ['--output-last-message', join(state, 'last-message.md')]),
    '--sandbox',
    readOnly ? 'read-only' : 'workspace-write',
    '-c',
    'approval_policy="never"',
    ...(readOnly ? [] : ['-c', 'sandbox_workspace_write.network_access=false']),
    // A TOML array, whose strings JSON's quoting writes correctly.
    ...(readOnly || writable.length === 0
      ? []
      : ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(writable)}`]),
    '-c',
    'web_search="disabled"',
    '-c',
    'tools.web_search=false',
    ...(model === undefined ? [] : ['-m', model]),
    ...(resume === undefined ? ['--'] : ['resume', '--', conversation(resume)]),
    prompt,
  ]
}

/**
 * What fences a session to `dir`: its writes sandboxed there with no
 * network, web search off (as `jobArgs`; its Codex folder has no MCP
 * servers), and
 * approvals asked in the terminal (`on-request`), whatever `config.toml`
 * says.
 * @public exported for its test
 */
export function fenceArgs(dir: string): string[] {
  return [
    '-C',
    dir,
    '--sandbox',
    'workspace-write',
    '-c',
    'approval_policy="on-request"',
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    'web_search="disabled"',
    '-c',
    'tools.web_search=false',
  ]
}

/** A message out of an event's `error`, or its own `message`. */
function messageOf(r: Record<string, unknown>): string {
  const error = r['error']
  const nested =
    error !== null && typeof error === 'object'
      ? (error as Record<string, unknown>)['message']
      : undefined
  const own = r['message']
  const text = typeof nested === 'string' ? nested : typeof own === 'string' ? own : ''
  return text.trim() === '' ? 'Codex reported an error.' : text.trim()
}

/** What a turn used: its input and output tokens (the cached input is part
 *  of the input). Null when it does not say. */
function tokensOf(r: Record<string, unknown>): number | null {
  const usage = r['usage']
  if (usage === null || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  const count = (key: string): number => {
    const n = u[key]
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0
  }
  const total = count('input_tokens') + count('output_tokens')
  return total > 0 ? total : null
}

/**
 * One line of `codex exec --json`: the thread, a turn's start and end with
 * what it used, and errors. Anything else (items) is nothing to the host.
 * @public exported for its test
 */
export function readJobEvent(line: string): JobEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const r = parsed as Record<string, unknown>
  switch (r['type']) {
    case 'thread.started': {
      const id = r['thread_id']
      return typeof id === 'string' && CONVERSATION_ID.test(id) ? { kind: 'thread', id } : null
    }
    case 'turn.started':
      return { kind: 'turn-started' }
    case 'turn.completed': {
      const tokens = tokensOf(r)
      return tokens === null ? { kind: 'turn-completed' } : { kind: 'turn-completed', tokens }
    }
    case 'turn.failed':
      return { kind: 'turn-failed', message: messageOf(r) }
    case 'error':
      return { kind: 'error', message: messageOf(r) }
    default:
      return null
  }
}

export interface CodexProviderDeps {
  resolveBin?: () => string | null
  /** The environment Codex runs from, `CODEX_HOME` and its keys among it. */
  base?: NodeJS.ProcessEnv
  /** The environment its preset sets, which its jobs get too: the person
   *  set it on purpose (a key, a config folder). */
  env?: () => Record<string, string>
}

export function codexProvider(deps: CodexProviderDeps = {}): AgentProvider {
  const base = deps.base ?? process.env
  /** Where the person's Codex folder is: their environment, then the
   *  preset's (a `CODEX_HOME` it sets). */
  const person = (): NodeJS.ProcessEnv => ({ ...base, ...deps.env?.() })
  const bin = deps.resolveBin ?? (() => resolveCodexBin(base))
  return {
    id: 'codex',
    label: 'Codex',
    notInstalled: NOT_INSTALLED,
    installed: () => bin() !== null,
    // Codex keeps its own home; Holi has nothing to provision in it.
    configure: async () => ({ dir: personCodexHome(person()) }),
    terminal(target, opts = {}) {
      const path = bin()
      if (path === null) return null
      const env = buildAgentEnv(base, { binDir: target.binDir })
      delete env[SESSION_ENV]
      if (opts.session !== undefined) env[SESSION_ENV] = opts.session
      // A fenced session runs on a Codex folder of its own, without the
      // person's MCP servers.
      if (opts.fence !== undefined) env.CODEX_HOME = prepareCodexHome(opts.fence.state, person())
      const asked = opts.prompt === undefined || opts.prompt.trim() === '' ? undefined : opts.prompt
      return {
        bin: path,
        args: [
          '-c',
          notifyOverride(),
          '-c',
          NOTIFICATIONS_OVERRIDE,
          ...(opts.fence === undefined ? [] : fenceArgs(opts.fence.dir)),
          // The conversation and the first ask after `--`, so neither is
          // ever read as a flag, and an ask that reads `resume` is the ask.
          ...(opts.resume === undefined
            ? asked === undefined
              ? []
              : ['--', asked]
            : opts.resume === 'pick'
              ? ['resume']
              : [
                  'resume',
                  '--',
                  conversation(opts.resume),
                  ...(asked === undefined ? [] : [asked]),
                ]),
        ],
        env,
      }
    },
    release: (state) => releaseCodexHome(state, person()),
    capabilities: {
      turns: { routes: registerCodexRoutes },
      fenced: true,
      jobs: {
        readsAnywhere: true,
        command(run) {
          const path = bin()
          if (path === null) return null
          // No Holi commands on its PATH and no session id: a job reaches
          // nothing of Holi's, only the folders its sandbox lets it write.
          // Its sandbox can still read the disk; what a scratch job hands the
          // vault is what Holi copies back. Its Codex folder is its own, with
          // no MCP servers, and a follow-up finds its thread there; a
          // `CODEX_HOME` the preset sets is the person's folder it copies.
          const preset = deps.env?.() ?? {}
          const env = { ...buildAgentEnv(base), ...preset }
          delete env[SESSION_ENV]
          env.CODEX_HOME = prepareCodexHome(run.state, person())
          return { bin: path, args: jobArgs(run), env }
        },
        event: readJobEvent,
      },
    },
  }
}
