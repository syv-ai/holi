/**
 * The activity log: what Holi does in the background, as VS Code's Output
 * channels (docs/features/status-bar.md). The sync engine writes a line for
 * each commit, pull, merge, push and sync-state change, the plugins for what
 * they start and stop, and the app for updates and failures; the renderer
 * shows it in the bottom panel's Output tab.
 *
 * A bounded ring in memory and nothing on disk: it is a window onto what is
 * happening now, not an audit trail, and git keeps the history that matters.
 * Every line is scrubbed of credentials as it is written, so nothing that
 * reaches the renderer (or a copy to the clipboard) can carry a token.
 *
 * Pure Node, no Electron: the composition root hands it the push.
 */

export type ActivityChannel = 'git' | 'sync' | 'agent' | 'plugins' | 'app'

export const ACTIVITY_CHANNELS: readonly ActivityChannel[] = [
  'git',
  'sync',
  'agent',
  'plugins',
  'app',
]

export type ActivityLevel = 'info' | 'warn' | 'error'

/** One line of the log, as the renderer gets it. */
export interface ActivityEntry {
  /** Increasing for the life of the process, so the renderer can merge a
   *  snapshot with pushes that raced it. */
  id: number
  /** ISO instant. */
  at: string
  channel: ActivityChannel
  level: ActivityLevel
  message: string
  /** More than a line: the git error text, the paths a commit took. */
  detail?: string
  /** The vault it is about, when it is about one. */
  remote?: string
}

/** What a writer gives; the log stamps the rest. */
export interface ActivityInput {
  channel: ActivityChannel
  level?: ActivityLevel
  message: string
  detail?: string
  remote?: string
}

/** How a part of Holi writes to the log. */
export type ActivityWrite = (input: ActivityInput) => void

export interface ActivityLog {
  write: ActivityWrite
  /** Every line still held, oldest first. */
  entries(): ActivityEntry[]
  /** Forget everything held. Ids keep counting. */
  clear(): void
}

export const ACTIVITY_CAPACITY = 2000

/** A detail longer than this is cut: a git error is a few lines, and a
 *  runaway stderr must not fill the ring's memory. */
const MAX_DETAIL = 4000

/**
 * Remove anything that looks like a credential.
 *
 * Holi never puts a token in a URL or an argument (`git.ts` passes it through
 * `GIT_ASKPASS`), so this is the belt to that braces: a remote someone set by
 * hand with a token in it, a `Bearer` header in an error, a pasted PAT.
 */
export function scrubSecrets(text: string): string {
  return (
    text
      // userinfo in a URL: https://x-access-token:ghs_…@github.com, https://user:pass@host
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1***@')
      // GitHub token shapes: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
      .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '***')
      // Authorization headers
      .replace(/\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 ***')
      // KEY=value pairs that name a secret (an env dump in an error)
      .replace(
        /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)=\S+/g,
        '$1=***',
      )
  )
}

export function createActivityLog(
  opts: {
    capacity?: number
    now?: () => string
    /** Each line as it is written, already scrubbed: the push to the window. */
    onEntry?: (entry: ActivityEntry) => void
  } = {},
): ActivityLog {
  const capacity = Math.max(1, opts.capacity ?? ACTIVITY_CAPACITY)
  const now = opts.now ?? (() => new Date().toISOString())
  // A fixed array used as a ring: a 2000-entry shift on every write would be
  // quadratic over a long session.
  const ring: (ActivityEntry | undefined)[] = new Array(capacity)
  let start = 0
  let size = 0
  let nextId = 1

  return {
    write(input) {
      const detail =
        input.detail === undefined || input.detail.trim() === ''
          ? undefined
          : scrubSecrets(input.detail.trimEnd()).slice(0, MAX_DETAIL)
      const entry: ActivityEntry = {
        id: nextId++,
        at: now(),
        channel: input.channel,
        level: input.level ?? 'info',
        message: scrubSecrets(input.message),
        ...(detail === undefined ? {} : { detail }),
        ...(input.remote === undefined ? {} : { remote: input.remote }),
      }
      if (size < capacity) {
        ring[(start + size) % capacity] = entry
        size++
      } else {
        ring[start] = entry
        start = (start + 1) % capacity
      }
      try {
        opts.onEntry?.(entry)
      } catch (err) {
        // A window that went away must not make writing a log line throw into
        // the sync loop.
        console.error('[activity] push failed:', err)
      }
    },
    entries() {
      const out: ActivityEntry[] = []
      for (let i = 0; i < size; i++) out.push(ring[(start + i) % capacity]!)
      return out
    },
    clear() {
      ring.fill(undefined)
      start = 0
      size = 0
    },
  }
}

/** A thrown thing as log text: git's stderr when it has one, which says why,
 *  else the message. */
export function errorText(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const stderr = (err as { stderr?: unknown }).stderr
    if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim()
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(err)
}
