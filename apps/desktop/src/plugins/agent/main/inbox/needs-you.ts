/**
 * Needs-you notifies (docs/features/agent-inbox.md). When a session's listing
 * goes into Claude Code's `waiting` status, the inbox gets one notice that
 * opens that session: on the edge into it, once until the session stops
 * waiting. The listing is the source, never a `Notification` hook, which is
 * late or partial (docs/features/agent-sessions.md).
 *
 * Not while the person is plainly looking: a session Holi has a terminal open
 * on, with Holi's window focused, already shows its prompt.
 *
 * No Electron import: this loads under plain Node like the rest of the plugin.
 */
import type { SessionSummary } from '../claude/listing'
import type { AgentSessions } from '../host/sessions'
import { enteredNeedsYou, type InboxNotice } from './rules'

export interface NeedsYouDeps {
  sessions: Pick<AgentSessions, 'onSessions' | 'watched'>
  focused(): boolean
  raise(notice: InboxNotice): Promise<unknown>
  log?: (msg: string) => void
}

/** What the inbox says about a session waiting on you. */
export const needsYouNotice = (s: SessionSummary): InboxNotice => ({
  title: `${s.name} needs you`,
  line:
    s.waitingFor === undefined
      ? 'Claude is waiting for you.'
      : `Claude is waiting: ${s.waitingFor}.`,
  session: s.id,
})

/** Watch the vault's sessions for needs-you. Returns the undo. */
export function watchNeedsYou(deps: NeedsYouDeps): () => void {
  let waiting = new Set<string>()
  return deps.sessions.onSessions((sessions) => {
    const step = enteredNeedsYou(waiting, sessions)
    waiting = step.waiting
    for (const s of step.entered) {
      if (deps.sessions.watched(s.id) && deps.focused()) continue
      void deps
        .raise(needsYouNotice(s))
        .catch((err: unknown) => deps.log?.(`needs-you notice failed: ${String(err)}`))
    }
  })
}
