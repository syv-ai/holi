/**
 * Needs-you notifies (docs/features/agent-inbox.md). When a session's listing
 * goes into Claude Code's `waiting` status, the inbox gets one notice that
 * opens that session: on the edge into it, once until the session stops
 * waiting. The listing is the source, never a `Notification` hook, which is
 * late or partial (docs/features/agent-sessions.md).
 *
 * The inbox outlives Holi, the set of waiting sessions does not: a session
 * the inbox already holds an entry for, of any age, starts out as waiting,
 * so reopening the vault does not tell about it again.
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
  /** The sessions the inbox already has an entry for. */
  told(): Promise<Iterable<string>>
  raise(notice: InboxNotice): Promise<unknown>
  log?: (msg: string) => void
}

/** What the inbox says about a session waiting on you. */
const needsYouNotice = (s: SessionSummary): InboxNotice => ({
  title: `${s.name} needs you`,
  line:
    s.waitingFor === undefined
      ? 'Claude is waiting for you.'
      : `Claude is waiting: ${s.waitingFor}.`,
  session: s.id,
})

/** Watch the vault's sessions for needs-you. Returns the undo. */
export function watchNeedsYou(deps: NeedsYouDeps): () => void {
  // One listing at a time, in order, after the inbox has been read.
  let waiting: Promise<Set<string>> = deps.told().then(
    (ids) => new Set(ids),
    (err: unknown) => {
      deps.log?.(`needs-you could not read the inbox: ${String(err)}`)
      return new Set<string>()
    },
  )
  return deps.sessions.onSessions((sessions) => {
    waiting = waiting.then((before) => {
      const step = enteredNeedsYou(before, sessions)
      for (const s of step.entered) {
        if (deps.sessions.watched(s.id) && deps.focused()) continue
        void deps
          .raise(needsYouNotice(s))
          .catch((err: unknown) => deps.log?.(`needs-you notice failed: ${String(err)}`))
      }
      return step.waiting
    })
  })
}
