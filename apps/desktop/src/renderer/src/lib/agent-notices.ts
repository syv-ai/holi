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
 * lives in `.holi/settings.local.json`, which is outside `AGENT_CONFIG_FILES`
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
