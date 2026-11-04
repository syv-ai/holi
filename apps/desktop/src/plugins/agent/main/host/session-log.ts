/**
 * The agent's lines in the activity log (docs/features/status-bar.md): a
 * session starting, ending, and a turn finishing, read off the session list
 * the host already publishes. Changes only: the list is pushed on every
 * state change, and most of those are a session going from working to idle,
 * which the turn's end already says.
 */
import type { PluginCtx } from '../../../../main/plugin-api'
import type { SessionSummary } from '../claude/listing'

export function createSessionLog(log: PluginCtx['log']): {
  /** The list as it was published. */
  sessions(next: readonly SessionSummary[]): void
  /** A turn ended in the session `id`. */
  turnEnd(id: string): void
} {
  /** id → name, as last seen. Null until the first list, which is what was
   *  already running when the vault opened, not news. */
  let known: Map<string, string> | null = null
  return {
    sessions(next) {
      const now = new Map(next.map((s) => [s.id, s.name]))
      if (known !== null) {
        for (const [id, name] of now) {
          if (!known.has(id)) log('info', `Session started: ${name}`)
        }
        for (const [id, name] of known) {
          if (!now.has(id)) log('info', `Session ended: ${name}`)
        }
      }
      known = now
    },
    turnEnd(id) {
      const name = known?.get(id)
      log('info', name === undefined ? 'Turn ended' : `Turn ended: ${name}`)
    },
  }
}
