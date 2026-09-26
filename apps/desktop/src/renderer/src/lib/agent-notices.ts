/**
 * What a session's indicators say in words, kept pure so it can be tested
 * without an xterm.
 */

/** The mode actually in force — `activeModeAtom`'s resolution (D85). */
export type ColorMode = 'light' | 'dark'

/**
 * The theme nudge, or null.
 *
 * Claude Code reads its `settings.json` at start, so the `theme` Holi stamps
 * (D86) reaches a running session only on restart. A known limit: a sentence,
 * not a hot-swap of another program's settings.
 *
 * Compared here rather than fingerprinted in main: the setting is in
 * `app.local.yaml`, deliberately outside `AGENT_CONFIG_FILES` because local
 * files never sync.
 */
export function agentThemeNote(args: {
  running: boolean
  /** The mode resolved when the live session spawned; null when none has. */
  modeAtSpawn: ColorMode | null
  mode: ColorMode
}): string | null {
  const { running, modeAtSpawn, mode } = args
  if (!running || modeAtSpawn === null || modeAtSpawn === mode) return null
  return "restart to change Claude's theme"
}

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
 * The single derivation of one session's state, so its tab, sidebar card and
 * other indicators cannot disagree.
 *
 * A restart nudge is a steady amber dot with the reason on hover. Precedence:
 * waiting on you, then an open turn (transient), then the nudge (still true
 * after the turn).
 */
export function agentIndicator(args: {
  /** Claude Code's own answer for this session. */
  state: 'needs-you' | 'working' | 'idle'
  /** Only for 'needs-you': what it is waiting for. */
  waitingFor?: string
  configStale: boolean
  /** Its PTY is gone. Nothing about being out of date means anything then. */
  exited?: boolean
  /** `agentThemeNote`'s output, threaded through so there is one amber rule. */
  themeNote: string | null
}): AgentIndicator {
  const { state, waitingFor, configStale, exited = false, themeNote } = args

  if (exited) {
    return { dot: 'bg-muted-foreground', state: 'ended', title: 'this session has ended' }
  }

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

  // Both are about a session that is now out of date.
  const reasons = [
    configStale ? 'shared config changed; restart to pick it up' : null,
    themeNote,
  ].filter((r): r is string => r !== null)
  if (reasons.length > 0) {
    return { dot: 'bg-amber-400', state: 'needs restart', title: reasons.join(' · ') }
  }

  return {
    dot: 'bg-green-500',
    state: 'running',
    title: 'session running, the vault assistant is live',
  }
}

/** One session as the helpers below read it: its state, and whether it is still
 *  alive. A summary, minus the fields only a card shows. */
export interface FleetSession {
  state: 'needs-you' | 'working' | 'idle'
  waitingFor?: string
  configStale: boolean
  exited: boolean
}

/**
 * The sessions that make a vault switch worth stopping for: live, and either
 * mid-turn or waiting on an answer (D100).
 *
 * Every live session ends on a switch, idle ones included: a session in a
 * vault you left has no watcher or sync behind it. Only these are worth asking
 * about; an idle one's conversation can be resumed.
 */
export function sessionsWorthAsking<T extends FleetSession>(sessions: T[]): T[] {
  return sessions.filter((s) => !s.exited && (s.state === 'working' || s.state === 'needs-you'))
}
