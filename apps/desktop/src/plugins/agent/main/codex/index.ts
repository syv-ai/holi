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
 * No `electron` import: this loads under plain Node in the tests.
 */
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveBin, shellReadBridgeEnv } from '../../../../main/plugin-api'
import { buildAgentEnv } from '../claude/cli'
import { PTY_SESSION_ID } from '../host/pty-sessions'
import type { AgentProvider, RouteServer, TurnRouteDeps } from '../provider'

/** The variable that names the session to its hook. */
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
 *  bounded, and a no-op outside a Holi session or with Holi closed. */
export const NOTIFY_SCRIPT = [
  `case "\${${SESSION_ENV}:-}" in p*) ;; *) exit 0 ;; esac`,
  `case "$${SESSION_ENV}" in *[!0-9a-fp]*) exit 0 ;; esac`,
  ...shellReadBridgeEnv(['HOLI_BRIDGE_PORT', 'HOLI_BRIDGE_TOKEN']),
  `if [ -n "$HOLI_BRIDGE_PORT" ] && [ -n "$HOLI_BRIDGE_TOKEN" ]; then printf '%s' "$1" | curl -s -m 2 -o /dev/null -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:$HOLI_BRIDGE_PORT/codex/turn-end?t=$HOLI_BRIDGE_TOKEN&session=$${SESSION_ENV}" >/dev/null 2>&1; fi`,
  'true',
].join('; ')

/** The `-c` override that installs the hook: a TOML array, whose strings
 *  JSON's quoting writes correctly. */
export const notifyOverride = (): string =>
  `notify=${JSON.stringify(['sh', '-c', NOTIFY_SCRIPT, 'holi-notify'])}`

/** What Codex's turn JSON says about the session: its first ask and its
 *  thread. Another program's output, so anything unrecognised is nothing. */
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

/** Serve `/codex/turn-end`. Every answer is empty. Returns the undo. */
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
    capabilities: { turns: { routes: registerCodexRoutes } },
  }
}
