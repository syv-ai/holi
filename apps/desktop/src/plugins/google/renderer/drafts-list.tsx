/**
 * Every unsent draft, in one list.
 *
 * - **A new-message draft is reachable.** It belongs to no thread, so without
 *   this list the only way back to it is Gmail.
 * - **A thread with two drafts shows both.** The thread's *Continue draft* chip
 *   opens the newest; the other one lives here.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useState } from 'react'
import { FilePen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState, LoadingRows } from '@/composites/empty-state'
import { googleCap } from './google-cap'
import { activeRemoteAtom } from '@/plugin-api'
import type { MailAddress } from './mail-types'

export interface DraftSummary {
  draftId: string
  threadId: string | null
  to: MailAddress[]
  subject: string
  snippet: string
  date: string
}

function recipients(to: MailAddress[]): string {
  // Not a blank cell, which reads as a rendering bug rather than unaddressed.
  if (to.length === 0) return '(no recipient)'
  return to.map((address) => (address.name === '' ? address.email : address.name)).join(', ')
}

function shortDate(iso: string): string {
  if (iso === '') return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function DraftsList({
  onOpen,
  reloadKey = 0,
}: {
  onOpen: (draft: DraftSummary) => void
  /** Bumped by the caller after a save or a discard, so the list reflects a
   *  draft that has just appeared or gone. */
  reloadKey?: number
}): React.JSX.Element {
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Bumped by Try again, so a failed fetch can be asked again. */
  const [attempt, setAttempt] = useState(0)
  const remote = useAtomValue(activeRemoteAtom)

  useEffect(() => {
    if (remote === null) return
    let cancelled = false
    setError(null)
    void googleCap
      .drafts(remote)
      .then((result) => {
        if (!cancelled) setDrafts(result)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setDrafts([])
        setError(err instanceof Error ? err.message : 'Could not load your drafts.')
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey, remote, attempt])

  if (error !== null) {
    return (
      <EmptyState
        role="alert"
        title="Couldn’t load your drafts"
        description={error}
        action={{ label: 'Try again', onClick: () => setAttempt((n) => n + 1) }}
      />
    )
  }
  if (drafts === null) return <LoadingRows label="Loading drafts" lines={3} />
  if (drafts.length === 0) {
    return (
      <EmptyState
        icon={FilePen}
        title="No drafts"
        description="A message you start and leave unsent waits here."
      />
    )
  }

  return (
    <ul aria-label="Drafts">
      {drafts.map((draft) => (
        <li key={draft.draftId} className="border-b border-divider">
          {/* The stock `Button`: the gate bans a native `<button>`. */}
          <Button variant="ghost" size="row" className="w-full" onClick={() => onOpen(draft)}>
            <span className="flex min-w-0 flex-1 flex-col">
              {/* The second lines start where the recipient does: the icon's
                  14px plus the row's `gap-2`. */}
              <span className="flex items-baseline gap-2">
                <FilePen className="size-3.5 self-center text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{recipients(draft.to)}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {shortDate(draft.date)}
                </span>
              </span>
              <span className="block truncate pl-5.5 text-sm">
                {draft.subject === '' ? '(no subject)' : draft.subject}
              </span>
              <span className="block truncate pl-5.5 text-xs text-muted-foreground">
                {draft.snippet}
              </span>
            </span>
          </Button>
        </li>
      ))}
    </ul>
  )
}
