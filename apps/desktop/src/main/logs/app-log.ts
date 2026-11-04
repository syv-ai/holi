/**
 * The application log: everything Holi prints, for the bottom panel's Logs
 * tab (docs/features/status-bar.md). Main's own `console` and the window's
 * console messages, as they are written, raw: where the Output's activity log
 * is a few chosen lines about what Holi did, this is the stream a developer
 * reads when something went wrong.
 *
 * A bounded ring in memory and nothing on disk, as the activity log is, and
 * every line scrubbed of credentials the same way before it is kept, so
 * nothing that reaches the renderer or the clipboard can carry a token.
 *
 * Pure Node, no Electron: the composition root hands it the push and wires
 * the window's console in.
 */
import { format } from 'node:util'
import { scrubSecrets } from '../activity/log'

export type AppLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Which process printed it. */
export type AppLogSource = 'main' | 'renderer'

export interface AppLogEntry {
  /** Increasing for the life of the process, as the activity log's ids. */
  id: number
  /** ISO instant. */
  at: string
  level: AppLogLevel
  source: AppLogSource
  /** The `[router]`-style tag the line opened with, when it had one. */
  scope?: string
  /** The first line, without its scope. */
  message: string
  /** The lines after the first: a stack, a git error's text. */
  detail?: string
}

interface AppLogInput {
  level: AppLogLevel
  source: AppLogSource
  text: string
}

export interface AppLog {
  write(input: AppLogInput): void
  /** Every line still held, oldest first. */
  entries(): AppLogEntry[]
  /** Forget everything held. Ids keep counting. */
  clear(): void
}

const APP_LOG_CAPACITY = 5000

/** A line longer than this is cut: one runaway dump must not fill the ring's
 *  memory. */
const MAX_TEXT = 8000

/** `[router] post-write rescan: …` opens with its scope; so does
 *  `[plugin:pdf]`. */
const SCOPE = /^\[([\w:./@-]{1,48})\]\s*/

export function createAppLog(
  opts: {
    capacity?: number
    now?: () => string
    /** Each line as it is kept, already scrubbed: the push to the window. */
    onEntry?: (entry: AppLogEntry) => void
  } = {},
): AppLog {
  const capacity = Math.max(1, opts.capacity ?? APP_LOG_CAPACITY)
  const now = opts.now ?? (() => new Date().toISOString())
  // A fixed array used as a ring, as the activity log's.
  const ring: (AppLogEntry | undefined)[] = new Array(capacity)
  let start = 0
  let size = 0
  let nextId = 1

  return {
    write({ level, source, text }) {
      const clean = scrubSecrets(text.slice(0, MAX_TEXT)).trimEnd()
      if (clean.trim() === '') return
      const newline = clean.indexOf('\n')
      const head = newline < 0 ? clean : clean.slice(0, newline)
      const rest = newline < 0 ? '' : clean.slice(newline + 1)
      const scope = SCOPE.exec(head)
      const entry: AppLogEntry = {
        id: nextId++,
        at: now(),
        level,
        source,
        ...(scope ? { scope: scope[1] } : {}),
        message: scope ? head.slice(scope[0].length) : head,
        ...(rest.trim() === '' ? {} : { detail: rest }),
      }
      if (size < capacity) {
        ring[(start + size) % capacity] = entry
        size++
      } else {
        ring[start] = entry
        start = (start + 1) % capacity
      }
      // No console here: the console is what writes to this log.
      try {
        opts.onEntry?.(entry)
      } catch {
        // A window that went away must not make printing throw.
      }
    },
    entries() {
      const out: AppLogEntry[] = []
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

type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error'

const LEVELS: Record<ConsoleMethod, AppLogLevel> = {
  debug: 'debug',
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
}

/**
 * Copy what `target` prints into the log, as `source`. The console still
 * prints as before: this listens, it does not take over. Returns the undo.
 *
 * A line the log's own push prints (a failure while sending to the window)
 * is not logged again, or one failure would print forever.
 */
export function captureConsole(
  log: AppLog,
  target: Pick<Console, ConsoleMethod> = console,
  source: AppLogSource = 'main',
): () => void {
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>()
  let writing = false
  for (const method of Object.keys(LEVELS) as ConsoleMethod[]) {
    const original = target[method] as (...args: unknown[]) => void
    originals.set(method, original)
    target[method] = (...args: unknown[]) => {
      original.apply(target, args)
      if (writing) return
      writing = true
      try {
        log.write({ level: LEVELS[method], source, text: format(...args) })
      } finally {
        writing = false
      }
    }
  }
  return () => {
    for (const [method, original] of originals) target[method] = original
  }
}

/** A renderer console message's level, as Electron names it. */
export function rendererLevel(level: 'info' | 'warning' | 'error' | 'debug'): AppLogLevel {
  return level === 'warning' ? 'warn' : level
}
