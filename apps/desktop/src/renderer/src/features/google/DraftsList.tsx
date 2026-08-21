/**
 * Every unsent draft, in one list (D71).
 *
 * It answers three questions at once, and that is why it is in v1 rather than
 * deferred:
 *
 * - **A new-message draft is reachable.** It belongs to no thread, so without
 *   this list the only way back to it is Gmail — and "open Gmail to find your
 *   draft" is the thing this pillar is removing.
 * - **A thread with two drafts shows both.** The thread's *Continue draft* chip
 *   opens the newest; the other one lives here. That is the whole answer to an
 *   ambiguity the spec left open.
 * - **No path ends at a browser.**
 */
import { useEffect, useState } from 'react'
import { FilePen } from 'lucide-react'
import { Button } from '@/primitives'
import { trpc } from '../../lib/trpc'
import type { MailAddress } from '../../lib/mail-types'

export interface DraftSummary {
  draftId: string
  threadId: string | null
  to: MailAddress[]
  subject: string
  snippet: string
  date: string
}

function recipients(to: MailAddress[]): string {
  // Not a blank cell. A blank row on the one screen where the user is looking
  // for something they half-wrote reads as a rendering bug, and the draft looks
  // lost rather than unaddressed.
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

  useEffect(() => {
    let cancelled = false
    setError(null)
    void trpc.google.drafts
      .query()
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
  }, [reloadKey])

  if (error !== null) {
    return <p className="p-6 text-center text-sm text-muted-foreground">{error}</p>
  }
  if (drafts === null) {
    return <p className="p-6 text-center text-sm text-muted-foreground">Loading drafts…</p>
  }
  if (drafts.length === 0) {
    return <p className="p-6 text-center text-sm text-muted-foreground">No drafts.</p>
  }

  return (
    <ul aria-label="Drafts">
      {drafts.map((draft) => (
        <li key={draft.draftId}>
          {/* The `Button` primitive, not a native one — the boundaries gate
              bans `<button>` outside primitives/, and the thread rows beside
              this list are built the same way. */}
          <Button
            variant="ghost"
            className="block h-auto w-full rounded-none border-b border-divider px-3 py-2 text-left"
            onClick={() => onOpen(draft)}
          >
            <span className="flex items-baseline gap-1">
              <FilePen size={11} className="shrink-0 self-center text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs">{recipients(draft.to)}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {shortDate(draft.date)}
              </span>
            </span>
            <span className="block truncate pl-3.5 text-xs">
              {draft.subject === '' ? '(no subject)' : draft.subject}
            </span>
            <span className="block truncate pl-3.5 text-[11px] text-muted-foreground">
              {draft.snippet}
            </span>
          </Button>
        </li>
      ))}
    </ul>
  )
}
