/**
 * A session's turns, read off its terminal, for a provider whose hooks do not
 * say (docs/features/agent-sessions.md, Providers).
 *
 * **Signals, never text.** What goes in and out of the PTY is read for three
 * things only, and none of them is what the agent wrote:
 *
 * - **Enter** typed while no turn is running begins one. A paste's own
 *   newlines are inside its bracketed-paste frame and do not count.
 * - **Quiet** ends one: a TUI at work redraws its spinner or its timer every
 *   second, so a turn with no output for `idleMs` is over, or is waiting on
 *   the person. A hook that reports the end (`end`) ends it sooner.
 * - **A notification** asks for the person: a bare bell, or an OSC 9 or
 *   OSC 777 desktop notification, the sequences agents print when a turn
 *   needs an answer or has finished while nobody looked.
 *
 * Coarser than a hook by design: good enough for a status dot and the sync
 * pause, which has its own safety cap; not for chaining work on.
 *
 * Pure: the clock is injected, so the tests drive it without a PTY.
 */

/** How long a turn may print nothing before it is taken to be over. */
const IDLE_MS = 5_000

/** The longest OSC body kept while scanning: a notification is short, and a
 *  runaway sequence must not grow without bound. */
const OSC_MAX = 256

export interface TurnSignalsDeps {
  onBegin(): void
  onEnd(): void
  onAttention(): void
  idleMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface TurnSignals {
  /** What the person typed, as it goes to the PTY. */
  input(data: string): void
  /** What the program printed. */
  output(data: string): void
  /** A turn began without a keystroke: a session started on a prompt. */
  begin(): void
  /** A hook said the turn ended. */
  end(): void
  /** Whether a turn is running. */
  readonly inTurn: boolean
  dispose(): void
}

const PASTE = /\x1b\[200~[\s\S]*?\x1b\[201~/g

/** Whether typed `data` submits: an Enter outside any bracketed paste. */
export function submits(data: string): boolean {
  return data.replace(PASTE, '').includes('\r')
}

/** An OSC body that is a desktop notification: OSC 9 (but not OSC 9;4, the
 *  progress report) or OSC 777's `notify`. */
export function isNotification(body: string): boolean {
  if (body.startsWith('9;')) return !body.startsWith('9;4;')
  return body.startsWith('777;notify')
}

type ScanState = 'text' | 'esc' | 'osc' | 'osc-esc'

/**
 * A scanner for notifications across output chunks: a sequence split between
 * two chunks is still one sequence.
 */
export function createNotificationScanner(onNotify: () => void): (data: string) => void {
  let state: ScanState = 'text'
  let body = ''
  const closeOsc = (): void => {
    if (isNotification(body)) onNotify()
    body = ''
    state = 'text'
  }
  return (data) => {
    for (const ch of data) {
      switch (state) {
        case 'text':
          if (ch === '\x1b') state = 'esc'
          else if (ch === '\x07') onNotify()
          break
        case 'esc':
          if (ch === ']') {
            state = 'osc'
            body = ''
          } else state = ch === '\x1b' ? 'esc' : 'text'
          break
        case 'osc':
          if (ch === '\x07') closeOsc()
          else if (ch === '\x1b') state = 'osc-esc'
          else if (body.length < OSC_MAX) body += ch
          break
        case 'osc-esc':
          // ESC \ is the string terminator; anything else abandons the OSC.
          if (ch === '\\') closeOsc()
          else {
            body = ''
            state = ch === ']' ? 'osc' : 'text'
          }
          break
      }
    }
  }
}

export function createTurnSignals(deps: TurnSignalsDeps): TurnSignals {
  const idleMs = deps.idleMs ?? IDLE_MS
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer =
    deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  let inTurn = false
  let timer: unknown = null
  let disposed = false

  const stopTimer = (): void => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }
  const arm = (): void => {
    stopTimer()
    timer = setTimer(() => {
      timer = null
      finish()
    }, idleMs)
  }
  const finish = (): void => {
    stopTimer()
    if (!inTurn || disposed) return
    inTurn = false
    deps.onEnd()
  }
  const scan = createNotificationScanner(() => {
    if (!disposed) deps.onAttention()
  })

  const begin = (): void => {
    if (disposed || inTurn) return
    inTurn = true
    deps.onBegin()
    arm()
  }

  return {
    input(data) {
      if (submits(data)) begin()
    },
    begin,
    output(data) {
      if (disposed) return
      scan(data)
      if (inTurn) arm()
    },
    end: finish,
    get inTurn() {
      return inTurn
    },
    dispose() {
      disposed = true
      stopTimer()
    },
  }
}
