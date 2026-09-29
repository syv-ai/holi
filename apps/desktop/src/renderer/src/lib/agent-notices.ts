/**
 * What a session's indicators say in words, kept pure so it can be tested
 * without an xterm.
 */

/** How one session is doing, in the form every place that shows it uses. */
export interface AgentIndicator {
  /** Utility classes for the status dot. */
  dot: string
  /** The word beside the dot: short enough for a crowded header. */
  state: string
  /** The tooltip: the whole sentence. */
  title: string
}

/**
 * The single derivation of one session's state, so its row, tab and orb
 * cannot disagree. Waiting on you first, then an open turn.
 *
 * Only live sessions are shown anywhere (D110): a stopped or finished one is in
 * Claude Code's agent list, not Holi's.
 */
export function agentIndicator(args: {
  /** Claude Code's own answer for this session. */
  state: 'needs-you' | 'working' | 'idle'
  /** Only for 'needs-you': what it is waiting for. */
  waitingFor?: string
}): AgentIndicator {
  const { state, waitingFor } = args

  // The loudest state: blocked on a dialog until you answer.
  if (state === 'needs-you') {
    return {
      dot: 'bg-orange-500',
      state: 'needs you',
      title:
        waitingFor === undefined
          ? 'Claude is waiting for you'
          : `Claude is waiting for you: ${waitingFor}`,
    }
  }

  if (state === 'working') {
    return {
      dot: 'motion-pulse bg-amber-400',
      state: 'working…',
      title: 'Claude is working on your turn',
    }
  }

  return {
    dot: 'bg-green-500',
    state: 'running',
    title: 'session running, ready for your next message',
  }
}

/** One session as the helpers below read it. */
export interface FleetSession {
  state: 'needs-you' | 'working' | 'idle'
  waitingFor?: string
}

/**
 * The sessions worth asking about before something stops them (a vault
 * switch, quit, or Stop on its row): mid-turn, or waiting on an answer.
 *
 * An idle one stops without a question: its conversation stays in Claude Code's
 * agent list and picks up where it left off.
 */
export function sessionsWorthAsking<T extends FleetSession>(sessions: T[]): T[] {
  return sessions.filter((s) => s.state === 'working' || s.state === 'needs-you')
}

/** Below this, a session's context reading is muted, like its name. */
export const CONTEXT_WARM_AT = 60
/** Where the ramp reaches full red. */
const CONTEXT_FULL_AT = 99

/**
 * The colour of a session's context reading, or null for the row's own muted
 * text.
 *
 * From 60% it ramps smoothly from `--context-warm` to `--context-full`,
 * mixed rather than stepped so a reading that climbs a point at a time never
 * jumps. Text colour only, on no background.
 */
export function contextColour(percent: number): string | null {
  if (percent < CONTEXT_WARM_AT) return null
  const span = CONTEXT_FULL_AT - CONTEXT_WARM_AT
  const t = Math.round((Math.min(percent - CONTEXT_WARM_AT, span) / span) * 100)
  return `color-mix(in oklab, var(--context-full) ${t}%, var(--context-warm))`
}
