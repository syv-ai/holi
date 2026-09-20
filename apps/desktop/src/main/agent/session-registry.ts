/**
 * What Claude Code says about its own sessions (D100).
 *
 * Holi spawns the `claude` processes, so it knows which sessions exist. It does
 * **not** derive what they are doing: whether a session is working, waiting for
 * you, or idle, and what it is called, are facts Claude Code maintains and
 * publishes. This module is the only place in Holi that asks.
 *
 * **The command, never the files.** The state lives in
 * `$CLAUDE_CONFIG_DIR/sessions/<pid>.json`, and Anthropic's documentation says
 * those files are not a stable interface and that `claude agents --json` is. So
 * the directory is an **edge trigger** — `watch` says *something moved*, and
 * `readRows` says *what*. Nothing here parses a format we were told not to
 * depend on, and a change to that format costs a wasted read rather than a
 * wrong answer.
 *
 * **Scoped by the config directory, not by a filter.** D86 gave every vault its
 * own `CLAUDE_CONFIG_DIR`, and the listing is per directory, so asking the
 * vault's directory already asks about the vault's sessions. The `cwd` check in
 * `readRows` is belt to those braces: a row acted on for the wrong tree is D87's
 * mistake, and the guard makes it impossible rather than unlikely.
 *
 * **It is allowed to answer nothing.** Every failure — no binary, a non-zero
 * exit, malformed output, a timeout — resolves to an empty map. The caller's
 * floor is the turn bracket the hooks already provide, so a vault whose CLI is
 * too old or too slow still reports `working`; it just never reports needs-you.
 * This runs on a watcher edge and must never become the thing that blocks a turn.
 *
 * No Electron import: this loads under plain Node like the rest of `agent/`.
 */
import { execFile } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { resolveClaudeBin } from './agent-runtime'

/** Claude Code's own session directory, under `$CLAUDE_CONFIG_DIR`. */
export const SESSIONS_DIR = 'sessions'

/** Hard cap on the listing. It is read on a filesystem edge, so a hung CLI would
 *  otherwise queue reads behind it for as long as it hangs. */
const READ_TIMEOUT_MS = 3_000
/** The rows carry heartbeat fields that move without any state change, so a
 *  burst is the normal case rather than the exception. */
const WATCH_DEBOUNCE_MS = 150
/**
 * How often to try again for a `sessions/` directory that does not exist yet.
 *
 * Holi deliberately does not create it (`agent-config-dir.ts`: Claude Code owns
 * that schema), and Claude Code creates it at `SessionStart`, measured at 0.94 s
 * after the spawn. So the **first** watch in a vault always fails, and a watch
 * attempted "lazily on the first spawn" is attempted at the one moment the
 * directory is still missing. Retrying is the only thing that actually takes.
 */
const WATCH_RETRY_MS = 500

/** The states Claude Code reports for a live session. `waiting` is the one Holi
 *  shows as needs-you; `shell` is a shell command running, which is working. */
const STATUSES = ['busy', 'waiting', 'idle', 'shell'] as const
export type SessionStatus = (typeof STATUSES)[number]

export interface SessionRow {
  pid: number
  /**
   * What Claude Code calls the session. Either something a person chose (`--name`
   * at spawn, `/rename` inside it) or the **default display name** Claude Code
   * gives an unnamed one: the working directory's name plus a two-character
   * suffix, `privat-d9`. That is unique per session but it is not a label — it
   * says nothing about the conversation, and Claude Code documents it as not
   * being a resume handle either.
   *
   * **The listing does not say which**, verified against 2.1.278: the underlying
   * file carries `nameSource`, the supported command does not. So the caller
   * cannot read the difference out of a row, and must know it another way: it
   * spawned the session, so it knows whether it passed `--name`, and it can see
   * the name change afterwards. See `nameSource` below.
   */
  name: string
  /**
   * `'user'` when someone named the session, absent or `'derived'` otherwise.
   *
   * **Currently never present**, because `claude agents --json` does not emit it
   * and this module refuses to read the file that does. Parsed anyway, because
   * the day the command starts emitting it is the day this becomes the direct
   * answer to a question the caller currently infers.
   */
  nameSource?: string
  status: SessionStatus
  /** Only when `status` is `waiting`: `permission prompt`, `input needed`,
   *  `sandbox request`. This is the reason a card can print. */
  waitingFor?: string
}

export interface SessionRegistry {
  /** pid → row, for the sessions whose cwd is `vaultRoot`. Never rejects. */
  readRows(args: { configDir: string; vaultRoot: string }): Promise<Map<number, SessionRow>>
  /**
   * Call `onChange` when the config directory's session state moves. Debounced,
   * and retried until `sessions/` exists — it is created by Claude Code shortly
   * after the first spawn, not by Holi, so the first watch in a vault is always
   * one the directory is not ready for. The returned unsubscribe stops the
   * retries too.
   */
  watch(configDir: string, onChange: () => void): () => void
}

export interface SessionRegistryDeps {
  /** Injected so tests never shell out, and so the binary search is the one
   *  `AgentRuntime` already does rather than a second copy of it. */
  resolveBin?: () => string | null
  run?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>
  log?: (msg: string) => void
}

function defaultRun(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { env, timeout: READ_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
  })
}

function isStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
}

/** One row, or null if it is not one we can act on. Row by row rather than
 *  all-or-nothing: a shape we do not recognise should cost that session's state,
 *  not every session's. */
function toRow(value: unknown, vaultRoot: string): SessionRow | null {
  if (value === null || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (r['cwd'] !== vaultRoot) return null
  if (typeof r['pid'] !== 'number' || !Number.isInteger(r['pid'])) return null
  if (!isStatus(r['status'])) return null
  return {
    pid: r['pid'],
    name: typeof r['name'] === 'string' ? r['name'] : '',
    nameSource: typeof r['nameSource'] === 'string' ? r['nameSource'] : undefined,
    status: r['status'],
    waitingFor: typeof r['waitingFor'] === 'string' ? r['waitingFor'] : undefined,
  }
}

export function createSessionRegistry(deps: SessionRegistryDeps = {}): SessionRegistry {
  const log = deps.log ?? ((msg: string) => console.log(`[session-registry] ${msg}`))
  const resolveBin = deps.resolveBin ?? (() => resolveClaudeBin())
  const run = deps.run ?? defaultRun

  return {
    async readRows({ configDir, vaultRoot }) {
      const empty = new Map<number, SessionRow>()
      const bin = resolveBin()
      if (bin === null) return empty

      let stdout: string
      try {
        // The whole environment, plus the one override. The child needs the
        // user's PATH and keychain access to answer at all, and every failure
        // below is already an empty answer rather than a thrown one.
        stdout = await run(bin, ['agents', '--json'], {
          ...process.env,
          CLAUDE_CONFIG_DIR: configDir,
        })
      } catch (err: unknown) {
        log(`listing failed: ${String(err)}`)
        return empty
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(stdout)
      } catch {
        log('listing was not JSON')
        return empty
      }
      if (!Array.isArray(parsed)) return empty

      const rows = new Map<number, SessionRow>()
      for (const entry of parsed) {
        const row = toRow(entry, vaultRoot)
        if (row !== null) rows.set(row.pid, row)
      }
      return rows
    },

    watch(configDir, onChange) {
      let watcher: FSWatcher | null = null
      let debounce: ReturnType<typeof setTimeout> | null = null
      let retry: ReturnType<typeof setTimeout> | null = null
      let stopped = false

      /** True once a first attempt has failed, so a later success is news. */
      let retried = false

      const attach = (): void => {
        if (stopped || watcher !== null) return
        try {
          watcher = watch(join(configDir, SESSIONS_DIR), () => {
            if (debounce !== null) clearTimeout(debounce)
            debounce = setTimeout(() => {
              debounce = null
              onChange()
            }, WATCH_DEBOUNCE_MS)
          })
          // A watcher on a directory that goes away throws on some platforms, and
          // losing the edge is a stale card rather than a broken app.
          watcher.on('error', (err) => log(`watch failed: ${String(err)}`))
          // The directory appearing is itself the news, and it appeared between
          // the failed attempt and this one, so nothing else will report it. On
          // a first-attempt success the caller has just read anyway.
          if (retried) onChange()
        } catch {
          // No `sessions/` yet. Claude Code makes it about a second into the
          // first spawn, and nothing else is going to tell us when.
          retried = true
          watcher = null
          retry = setTimeout(attach, WATCH_RETRY_MS)
        }
      }
      attach()

      return () => {
        stopped = true
        if (debounce !== null) clearTimeout(debounce)
        if (retry !== null) clearTimeout(retry)
        debounce = null
        retry = null
        watcher?.close()
        watcher = null
      }
    },
  }
}
