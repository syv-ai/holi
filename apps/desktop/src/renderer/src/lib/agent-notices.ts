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
 * The single derivation of the assistant's state, so the footer control (#15) and
 * the panel header cannot drift into saying different things about one session.
 *
 * The restart nudges used to be amber sentences spelled out in the header, which
 * was noise in the one strip that is meant to be glanceable. They are a *dot*
 * now: steady amber says "this session wants restarting", the reason is on hover,
 * and the Restart button is already an inch away. An open turn outranks a nudge
 * because it is the transient thing; the nudge is still true when the turn ends.
 */
export function agentIndicator(args: {
  running: boolean
  working: boolean
  configStale: boolean
  /** `agentThemeNote`'s output, threaded through so there is one amber rule. */
  themeNote: string | null
}): AgentIndicator {
  const { running, working, configStale, themeNote } = args

  if (working) {
    return {
      dot: 'animate-pulse bg-amber-400',
      state: 'working…',
      title: 'Claude is working on your turn',
    }
  }

  // Both are about a session that is now out of date, so neither means anything
  // when there is no session to be out of date.
  const reasons = running
    ? [configStale ? 'shared config changed; restart to pick it up' : null, themeNote].filter(
        (r): r is string => r !== null,
      )
    : []
  if (reasons.length > 0) {
    return { dot: 'bg-amber-400', state: 'needs restart', title: reasons.join(' · ') }
  }

  if (running) {
    return {
      dot: 'bg-green-500',
      state: 'running',
      title: 'session running, the vault assistant is live',
    }
  }
  return {
    dot: 'bg-muted-foreground',
    state: 'idle',
    title: 'no session, opens when you show the drawer',
  }
}
