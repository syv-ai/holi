/**
 * The agent's notifications, in the top right: an answer that is ready, or an
 * agent that needs you. Pressing one opens the full chat; ✕ dismisses it; a
 * permission prompt is answered on the card (Allow, Deny) without leaving the
 * page you are on. An answer goes by itself after a while, unless the pointer
 * is on it; a question stays until it is answered or dismissed.
 *
 * The cards follow Fisher UI's agent components (the approval card's pill and
 * actions), on Holi's primitives.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, IconButton } from '@/primitives'
import { AgentFace } from './AgentFace'
import {
  ANSWER_NOTICE_MS,
  agentNoticesAtom,
  dismissNoticeAtom,
  type AgentNotice,
} from '../../agent/renderer/state/notices'
import { openSessionAtom, pressAtom } from '../../agent/renderer/state/send'
import { agentSessionsAtom } from '../../agent/renderer/state/sessions'

const ENTER = '\r'
const ESCAPE = '\x1b'

const PILL = 'shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium'

function NoticeCard({ notice }: { notice: AgentNotice }): React.JSX.Element {
  const session = useAtomValue(agentSessionsAtom).find((s) => s.id === notice.sessionId) ?? null
  const dismiss = useSetAtom(dismissNoticeAtom)
  const openFull = useSetAtom(openSessionAtom)
  const press = useSetAtom(pressAtom)
  const [hovered, setHovered] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // An answer goes by itself, and waits while it is being read.
  useEffect(() => {
    if (notice.kind !== 'answer' || hovered) return
    const timer = setTimeout(() => dismiss(notice.id), ANSWER_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice.kind, notice.id, hovered, dismiss])

  const permission = notice.kind === 'needs-you' && notice.waitingFor === 'permission prompt'
  const answer = (keys: string): void => {
    void press({ id: notice.sessionId, keys }).then((res) => {
      if (res.ok) return dismiss(notice.id)
      setError(res.message)
    })
  }

  return (
    <article
      data-agent-notice={notice.kind}
      data-notice-session={notice.sessionId}
      className="pointer-events-auto motion-in-right overflow-hidden rounded-2xl border border-border/60 bg-popover text-popover-foreground shadow-popover"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <div className="flex items-start gap-2.5 p-3">
        {/* Press anywhere on the words to read it in full. */}
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Open ${notice.name}`}
          data-notice-open=""
          className="h-auto min-w-0 flex-1 items-start justify-start gap-2.5 rounded-xl p-1 text-left font-normal whitespace-normal"
          onClick={() => void openFull(notice.sessionId)}
        >
          <span className="mt-0.5 shrink-0">
            {session !== null ? (
              <AgentFace
                size="sm"
                seed={session.id}
                state={session.state}
                waitingFor={session.waitingFor}
                phase={session.phase}
              />
            ) : (
              <AgentFace size="sm" seed={notice.sessionId} state="off" muted />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-foreground">{notice.name}</span>
              <span
                className={
                  notice.kind === 'needs-you'
                    ? `${PILL} border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400`
                    : notice.failed === true
                      ? `${PILL} border-destructive/30 bg-destructive/10 text-destructive`
                      : `${PILL} border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400`
                }
              >
                {notice.kind === 'needs-you'
                  ? permission
                    ? 'Approval required'
                    : 'Needs you'
                  : notice.failed === true
                    ? 'Ended badly'
                    : 'Answer ready'}
              </span>
            </span>
            {notice.kind === 'answer' ? (
              <span className="line-clamp-3 text-xs text-muted-foreground">
                {notice.preview === ''
                  ? notice.failed === true
                    ? 'The last turn ended with an error.'
                    : 'It has finished.'
                  : notice.preview}
              </span>
            ) : (
              <span className="truncate font-mono text-xs text-muted-foreground">
                {permission && notice.tool !== ''
                  ? notice.tool
                  : (notice.waitingFor ?? 'It has a question')}
              </span>
            )}
          </span>
        </Button>
        <IconButton
          icon={X}
          label="Dismiss"
          size="sm"
          data-notice-dismiss=""
          onClick={() => dismiss(notice.id)}
        />
      </div>

      {notice.kind === 'needs-you' && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
          {permission && (
            <>
              <Button size="sm" onClick={() => answer(ENTER)}>
                Allow
              </Button>
              <Button size="sm" variant="outline" onClick={() => answer(ESCAPE)}>
                Deny
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => void openFull(notice.sessionId)}>
            {permission ? 'More choices' : 'Answer'}
          </Button>
        </div>
      )}
      {error !== null && <p className="px-3 pb-2 text-xs text-destructive">{error}</p>}
    </article>
  )
}

/** Every notification, newest at the bottom, in the column the overlay gives. */
export function AgentNotices(): React.JSX.Element | null {
  const notices = useAtomValue(agentNoticesAtom)
  if (notices.length === 0) return null
  return (
    <>
      {notices.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} />
      ))}
    </>
  )
}
