/**
 * `holi-signal`, the hook command for an agent a person added
 * (docs/features/agent-sessions.md, Harnesses): Codex's `notify` hook made
 * general. The person wires it into their CLI's own hooks:
 *
 *     holi-signal turn-end [--conversation <uuid>]
 *     holi-signal status [--context <percent>] [--model <name>]
 *
 * It sits in Holi's bin folder, first on every session's `PATH`, and posts
 * to the bridge's `/agent/signal`, found through the vault's
 * `bridge.local.env` and keyed by Holi's id for the session
 * (`HOLI_AGENT_SESSION`, which the PTY's environment carries to the CLI and
 * on to its hooks). Quiet, bounded and a no-op outside a Holi session or with
 * Holi closed: a hook must never fail the CLI's turn.
 *
 * The arguments go to Holi as they are, form-encoded by curl, and are read
 * here, so the script never parses or quotes them itself.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { shellReadBridgeEnv, type BridgeRoute } from '../../../../main/plugin-api'
import { SESSION_ENV } from '../codex'
import { CONVERSATION_ID, PTY_SESSION_ID } from '../host/pty-sessions'
import type { RouteServer } from '../provider'

const SIGNAL_COMMAND = 'holi-signal'
const SIGNAL_ROUTE = '/agent/signal'

const USAGE =
  'usage: holi-signal turn-end [--conversation <uuid>] | holi-signal status [--context <percent>] [--model <name>]'

/** @public exported for its test */
export const SIGNAL_SCRIPT = [
  '#!/bin/sh',
  `# ${SIGNAL_COMMAND}: tell Holi about the agent session this runs in. Written by Holi.`,
  'kind=$1',
  `case "$kind" in turn-end|status) shift ;; *) echo '${USAGE}' >&2; exit 2 ;; esac`,
  `case "\${${SESSION_ENV}:-}" in p*) ;; *) exit 0 ;; esac`,
  `case "$${SESSION_ENV}" in *[!0-9a-fp]*) exit 0 ;; esac`,
  ...shellReadBridgeEnv(['HOLI_BRIDGE_PORT', 'HOLI_BRIDGE_TOKEN']),
  '[ -n "$HOLI_BRIDGE_PORT" ] && [ -n "$HOLI_BRIDGE_TOKEN" ] || exit 0',
  // Each argument becomes `--data-urlencode arg=<it>`, in order.
  'n=$#',
  'while [ "$n" -gt 0 ]; do set -- "$@" --data-urlencode "arg=$1"; shift; n=$((n - 1)); done',
  `curl -s -m 2 -o /dev/null --data-urlencode "kind=$kind" "$@" "http://127.0.0.1:$HOLI_BRIDGE_PORT${SIGNAL_ROUTE}?t=$HOLI_BRIDGE_TOKEN&session=$${SESSION_ENV}" >/dev/null 2>&1`,
  'exit 0',
  '',
].join('\n')

/** Write `holi-signal` into Holi's bin folder when it is missing or old. */
export async function installSignalCommand(binDir: string): Promise<void> {
  const path = join(binDir, SIGNAL_COMMAND)
  const now = await readFile(path, 'utf8').catch(() => null)
  if (now === SIGNAL_SCRIPT) return
  await mkdir(binDir, { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, SIGNAL_SCRIPT, { mode: 0o755 })
  await chmod(temporary, 0o755)
  await rename(temporary, path)
}

type Signal =
  | { kind: 'turn-end'; conversationId?: string }
  | { kind: 'status'; contextPercent?: number; model?: string }

/**
 * What a `holi-signal` post said, or null when it is not one. Another
 * program's words: an option it does not know, or a value of the wrong
 * shape, is left out rather than refused.
 * @public exported for its test
 */
export function readSignal(body: string): Signal | null {
  const form = new URLSearchParams(body)
  const args = form.getAll('arg')
  const option = (name: string): string | undefined => {
    const at = args.lastIndexOf(`--${name}`)
    return at === -1 ? undefined : args[at + 1]
  }
  switch (form.get('kind')) {
    case 'turn-end': {
      const conversation = option('conversation')
      return conversation !== undefined && CONVERSATION_ID.test(conversation)
        ? { kind: 'turn-end', conversationId: conversation }
        : { kind: 'turn-end' }
    }
    case 'status': {
      const context = Number(option('context'))
      const model = option('model')?.trim()
      return {
        kind: 'status',
        ...(Number.isFinite(context) && context >= 0 && context <= 100
          ? { contextPercent: Math.round(context) }
          : {}),
        ...(model !== undefined && model !== '' ? { model: model.slice(0, 80) } : {}),
      }
    }
    default:
      return null
  }
}

export interface SignalRouteDeps {
  /** A signal from a session Holi runs, by its id. */
  onSignal(remote: string, session: string, signal: Signal): void
}

/** Serve `/agent/signal`. Every answer is empty. Returns the undo. */
export function registerSignalRoute(server: RouteServer, deps: SignalRouteDeps): () => void {
  const route: BridgeRoute = {
    body: 'text',
    handle(remote, query, body) {
      const session = query.get('session') ?? ''
      const signal = readSignal(body)
      if (PTY_SESSION_ID.test(session) && signal !== null) deps.onSignal(remote, session, signal)
      return { status: 204 }
    },
  }
  return server.route(SIGNAL_ROUTE, route)
}
