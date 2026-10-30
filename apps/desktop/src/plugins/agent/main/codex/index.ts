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
 * **Jobs** are `codex exec --json` in a scratch folder Holi made
 * (`../host/jobs.ts`): the workspace-write sandbox with no network, no MCP
 * servers and no web search, and an approval policy of never, so a step the
 * sandbox refuses fails rather than waiting on a person nobody is. The
 * sandbox keeps its writes to the folder; it can still read the disk, so
 * what bounds a job is what Holi copies back. Its JSONL events say how the
 * run went.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveBin, shellReadBridgeEnv } from '../../../../main/plugin-api'
import { buildAgentEnv } from '../claude/cli'
import { PTY_SESSION_ID } from '../host/pty-sessions'
import type { AgentProvider, JobEvent, RouteServer, TurnRouteDeps } from '../provider'

/**
 * The variable that names the session to its hook.
 * @public exported for its test
 */
export const SESSION_ENV = 'HOLI_AGENT_SESSION'

const NOT_INSTALLED =
  'Codex CLI not found on PATH. Install it (https://developers.openai.com/codex/cli) and restart Holi.'

/** `HOLI_CODEX_BIN` when set, else `codex` on `PATH`. */
function resolveCodexBin(env: NodeJS.ProcessEnv = process.env): string | null {
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
    ...(typeof thread === 'string' && /^[\w-]{1,80}$/.test(thread)
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

/**
 * What runs a job: `codex exec` in `cwd`, its writes sandboxed to it, with no
 * network and never asking. Every option before `--`, so the prompt is only
 * ever the prompt.
 *
 * The person's `config.toml` must not hand an unattended run tools outside
 * the sandbox, so the MCP servers are emptied and web search is off, under
 * both the key current Codex reads (`web_search`) and the older
 * `tools.web_search`. These keys are Codex's as best known, not verified
 * against a real `codex` here.
 * @public exported for its test
 */
export function jobArgs({
  cwd,
  prompt,
  model,
}: {
  cwd: string
  prompt: string
  model?: string
}): string[] {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C',
    cwd,
    '--sandbox',
    'workspace-write',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    'mcp_servers={}',
    '-c',
    'web_search="disabled"',
    '-c',
    'tools.web_search=false',
    ...(model === undefined ? [] : ['-m', model]),
    '--',
    prompt,
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

/**
 * One line of `codex exec --json`: the thread, a turn's start and end, and
 * errors. Anything else (items, usage) is nothing to the host.
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
      return typeof id === 'string' && /^[\w-]{1,80}$/.test(id) ? { kind: 'thread', id } : null
    }
    case 'turn.started':
      return { kind: 'turn-started' }
    case 'turn.completed':
      return { kind: 'turn-completed' }
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
}

export function codexProvider(deps: CodexProviderDeps = {}): AgentProvider {
  const bin = deps.resolveBin ?? (() => resolveCodexBin())
  return {
    id: 'codex',
    label: 'Codex',
    notInstalled: NOT_INSTALLED,
    installed: () => bin() !== null,
    // Codex keeps its own home; Holi has nothing to provision in it.
    configure: async () => ({ dir: process.env.CODEX_HOME ?? join(homedir(), '.codex') }),
    terminal(target, opts = {}) {
      const path = bin()
      if (path === null) return null
      const env = buildAgentEnv(process.env, { binDir: target.binDir })
      delete env[SESSION_ENV]
      if (opts.session !== undefined) env[SESSION_ENV] = opts.session
      return {
        bin: path,
        args: [
          '-c',
          notifyOverride(),
          ...(opts.resume === undefined
            ? []
            : ['resume', ...(opts.resume === 'pick' ? [] : [opts.resume])]),
          // After `--`, so an ask that starts with `-` or reads `resume` is
          // still the ask.
          ...(opts.prompt === undefined || opts.prompt.trim() === '' ? [] : ['--', opts.prompt]),
        ],
        env,
      }
    },
    capabilities: {
      turns: { routes: registerCodexRoutes },
      jobs: {
        command({ cwd, prompt, model }) {
          const path = bin()
          if (path === null) return null
          // No Holi commands on its PATH and no session id: a job writes
          // nothing of the vault but the folder it runs in. Its sandbox can
          // still read the disk; what reaches the vault is what Holi copies
          // back.
          const env = buildAgentEnv(process.env)
          delete env[SESSION_ENV]
          return {
            bin: path,
            args: jobArgs({ cwd, prompt, ...(model === undefined ? {} : { model }) }),
            env,
          }
        },
        event: readJobEvent,
      },
    },
  }
}
