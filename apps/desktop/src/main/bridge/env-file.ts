/**
 * Where whatever runs inside a vault finds the running Holi:
 * `.holi/state/bridge.local.env` at the vault's root.
 *
 * The `holi` command, the agent's turn-signal hook and
 * status line, and git's pre-commit hook and merge driver all walk up from
 * their current directory to the folder holding `.holi/vault` and read this
 * file. Any process in the vault finds it, whichever agent or terminal it runs
 * in, and a background session (whose environment is Claude Code's
 * supervisor's, not Holi's) finds it too.
 *
 * **A map that features contribute to.** The bridge contributes its port and
 * the vault's token; `contribute` returns the undo. Holi writes
 * the file whole when it opens the vault, rewrites it on every change, and
 * deletes it when it leaves, so a command run after Holi quits finds nothing
 * rather than a dead port.
 *
 * **Parsed, never sourced.** A collaborator could `git add -f` a file here
 * with anything in it, and the commands may run with Holi closed, so every
 * reader picks out the keys it wants and checks each value. Keys are
 * `HOLI_[A-Z_]+`, values digits or hex, both checked on the way in too.
 * Machine-local (`.local.`) and mode 0600: the tokens open the vault's bridge
 * and its Google account.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const BRIDGE_ENV_FILE = '.holi/state/bridge.local.env'

const KEY = /^HOLI_[A-Z_]+$/
const VALUE = /^[0-9a-f]+$/

export type BridgeVars = Readonly<Record<string, string>>

export interface BridgeEnv {
  /** Add `vars` to this vault's file. A key has one contributor. Returns the
   *  undo. The file is rewritten if the vault is open. */
  contribute(remote: string, vars: BridgeVars): () => void
  /** Holi opened the vault at `root`: write its file. */
  attach(remote: string, root: string): Promise<void>
  /** Holi is leaving the vault: delete its file. */
  detach(remote: string): Promise<void>
}

/** The file's text: `KEY=value` lines, sorted. Throws on an unsafe pair. */
export function bridgeEnvText(vars: BridgeVars): string {
  return Object.keys(vars)
    .sort()
    .map((key) => {
      const value = vars[key]!
      if (!KEY.test(key)) throw new Error(`${key} is not a HOLI_ key`)
      if (!VALUE.test(value)) throw new Error(`${key} is not digits or hex`)
      return `${key}=${value}\n`
    })
    .join('')
}

export function createBridgeEnv(
  log = (msg: string) => console.error(`[bridge] ${msg}`),
): BridgeEnv {
  const contributions = new Map<string, Set<BridgeVars>>()
  /** remote → the root of the open clone whose file is kept current. */
  const roots = new Map<string, string>()
  /** remote → its last write, so writes to one file land in order. */
  const writes = new Map<string, Promise<void>>()

  const merged = (remote: string): Record<string, string> =>
    Object.assign({}, ...(contributions.get(remote) ?? []))

  /** Queue `work` behind this vault's earlier writes. Never rejects. */
  const queue = (remote: string, work: () => Promise<void>): Promise<void> => {
    const next = (writes.get(remote) ?? Promise.resolve())
      .then(work)
      .catch((err: unknown) => log(`${BRIDGE_ENV_FILE} for ${remote}: ${String(err)}`))
    writes.set(remote, next)
    return next
  }

  /** Write the file whole, atomically, readable by this user only. */
  const write = (remote: string): Promise<void> =>
    queue(remote, async () => {
      const root = roots.get(remote)
      if (root === undefined) return
      const path = join(root, BRIDGE_ENV_FILE)
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      await writeFile(tmp, bridgeEnvText(merged(remote)), { mode: 0o600 })
      await rename(tmp, path)
    })

  return {
    contribute(remote, vars) {
      bridgeEnvText(vars) // refuse an unsafe pair now, not at the next write
      const held = merged(remote)
      const taken = Object.keys(vars).find((key) => key in held)
      if (taken !== undefined) throw new Error(`${taken} is already contributed`)
      const own = { ...vars }
      let set = contributions.get(remote)
      if (set === undefined) contributions.set(remote, (set = new Set()))
      set.add(own)
      void write(remote)
      return () => {
        if (contributions.get(remote)?.delete(own)) void write(remote)
      }
    },

    attach(remote, root) {
      roots.set(remote, root)
      return write(remote)
    },

    detach(remote) {
      const root = roots.get(remote)
      roots.delete(remote)
      if (root === undefined) return Promise.resolve()
      return queue(remote, () => rm(join(root, BRIDGE_ENV_FILE), { force: true }))
    },
  }
}

/**
 * POSIX sh that finds the vault from the current directory and sets each
 * shell variable in `keys` to its value in the vault's `bridge.local.env`,
 * or to empty when there is no vault, no file, no such key, or a value that
 * is not digits or hex. Never sources the file. One command per line, each
 * safe to join with `; `, and safe under `set -eu`.
 */
export function shellReadBridgeEnv(keys: readonly string[]): string[] {
  for (const key of keys) if (!KEY.test(key)) throw new Error(`${key} is not a HOLI_ key`)
  return [
    'holi_dir=$(pwd -P)',
    'while [ ! -f "$holi_dir/.holi/vault" ] && [ "$holi_dir" != / ]; do holi_dir=$(dirname "$holi_dir"); done',
    `holi_env="$holi_dir/${BRIDGE_ENV_FILE}"`,
    '[ -f "$holi_dir/.holi/vault" ] || holi_env=/dev/null',
    ...keys.flatMap((key) => [
      `${key}=$({ grep '^${key}=' "$holi_env" | head -n 1 | cut -d= -f2-; } 2>/dev/null || true)`,
      `case "$${key}" in *[!0-9a-f]*) ${key}= ;; esac`,
    ]),
  ]
}
