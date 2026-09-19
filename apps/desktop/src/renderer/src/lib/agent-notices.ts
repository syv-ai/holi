/**
 * What the agent panel owes the user in words, kept pure so it can be tested
 * without standing up an xterm.
 */

/** The mode actually in force — `activeModeAtom`'s resolution (D85). */
export type ColorMode = 'light' | 'dark'

/**
 * The theme nudge, or null.
 *
 * Claude Code reads its `settings.json` at start, so the `theme` Holi stamps
 * into the vault's config directory (D86) reaches a session that is already
 * running only when it restarts. That is a known limit and gets a sentence
 * rather than an attempt to hot-swap another program's settings.
 *
 * **Compared here rather than fingerprinted in main**, deliberately: the setting
 * lives in `.holi/settings/app.local.yaml`, which is outside `AGENT_CONFIG_FILES`
 * because `*.local.*` never syncs and so no collaborator's pull can change it.
 * Widening that set to catch a local theme flip would contradict the reason it
 * is drawn where it is. The renderer already knows both modes.
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

/** How the vault assistant is doing, in the one form both places that show it use. */
export interface AgentIndicator {
  /** Utility classes for the status dot. */
  dot: string
  /** The word beside the dot: short enough for a crowded header. */
  state: string
  /** The tooltip: the whole sentence, on both the dot and the footer control. */
  title: string
}

/**
 * The single derivation of ONE session's state, so a tab, a sidebar card and the
 * footer door cannot drift into saying different things about it.
 *
 * The restart nudges used to be amber sentences spelled out in the header, which
 * was noise in the one strip that is meant to be glanceable. They are a *dot*
 * now: steady amber says "this session wants restarting", the reason is on hover,
 * and the Restart button is already an inch away. An open turn outranks a nudge
 * because it is the transient thing; the nudge is still true when the turn ends,
 * and a session waiting on YOU outranks both.
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

  // The loudest state, and the only one that is about YOU rather than about
  // Claude: it is blocked on a dialog and nothing moves until it is answered.
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

/** The shape `fleetIndicator` reduces. A session's summary, plus whatever theme
 *  note the renderer derived for it. */
export interface FleetSession {
  state: 'needs-you' | 'working' | 'idle'
  waitingFor?: string
  configStale: boolean
  exited: boolean
}

/**
 * Every session of the vault, as one dot for the footer door.
 *
 * **Needs-you outranks working outranks a restart nudge**, which is the same
 * ordering one session already uses, applied across the set: the footer is a
 * door, and it should be painted by whichever session most wants you to open
 * it. An exited session contributes nothing — its tab says so, and the door is
 * about what is live.
 */
export function fleetIndicator(
  sessions: FleetSession[],
  /** True when any LIVE session was spawned under a different colour mode. */
  themeNote: string | null = null,
): AgentIndicator {
  const live = sessions.filter((s) => !s.exited)
  if (live.length === 0) {
    return {
      dot: 'bg-muted-foreground',
      state: 'idle',
      title: 'no session, opens when you show the drawer',
    }
  }

  const waiting = live.find((s) => s.state === 'needs-you')
  if (waiting !== undefined) {
    return agentIndicator({ ...waiting, themeNote: null })
  }
  if (live.some((s) => s.state === 'working')) {
    return agentIndicator({ state: 'working', configStale: false, themeNote: null })
  }
  return agentIndicator({
    state: 'idle',
    configStale: live.some((s) => s.configStale),
    themeNote,
  })
}
