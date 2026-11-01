/**
 * What the agent told the person (docs/features/agent-inbox.md): each
 * `holi agent notify`, each session that needed them, each teammate's
 * mention, newest first. A row opens its note or session; its X dismisses
 * it. Being shown reads everything in it, which clears the count, while the
 * rows that were unread keep their mark as long as the Inbox is open.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '@/plugin-api'
import {
  dismissInboxEntryAtom,
  inboxAtom,
  markInboxSeenAtom,
  openInboxEntryAtom,
  type InboxEntry,
} from '../state/inbox'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/composites/icon-button'

/** Today's time alone, an earlier day's date with it. */
function when(iso: string): string {
  const at = new Date(iso)
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (at.toDateString() === new Date().toDateString()) return time
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

function Row({ entry, unread }: { entry: InboxEntry; unread: boolean }): React.JSX.Element {
  const open = useSetAtom(openInboxEntryAtom)
  const dismiss = useSetAtom(dismissInboxEntryAtom)
  const opens = entry.path !== undefined || entry.session !== undefined
  return (
    <li className="group/row relative flex" data-inbox-entry={entry.id}>
      <Button
        variant="ghost"
        size="row"
        className={cn('w-full min-w-0', unread && 'bg-foreground/5')}
        disabled={!opens}
        onClick={() => open(entry)}
      >
        <span className="flex w-full min-w-0 flex-col gap-1 py-1 pe-7">
          <span className="flex min-w-0 items-baseline gap-3">
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-sm text-foreground',
                unread ? 'font-semibold' : 'font-medium',
              )}
            >
              {entry.title}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {when(entry.at)}
            </span>
          </span>
          {entry.line !== '' && (
            <span className="whitespace-normal text-sm text-muted-foreground">{entry.line}</span>
          )}
          {entry.path !== undefined && (
            <span className="truncate font-mono text-xs text-muted-foreground">{entry.path}</span>
          )}
        </span>
      </Button>
      <span className="absolute end-1.5 top-1.5 opacity-0 focus-within:opacity-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100">
        <IconButton label="Dismiss" size="icon-xs" onClick={() => void dismiss(entry.id)}>
          <X />
        </IconButton>
      </span>
    </li>
  )
}

export function InboxEntries(): React.JSX.Element | null {
  const { entries, unread } = useAtomValue(inboxAtom)
  const markSeen = useSetAtom(markInboxSeenAtom)
  // The entries that were unread when they came into view, by id, so a
  // dismissed row does not pass its mark to the next.
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set())

  // What arrives while the Inbox is shown is seen as it arrives. The unread
  // ones are the newest: the list is newest first.
  useEffect(() => {
    if (unread === 0) return
    const arrived = entries.slice(0, unread).map((e) => e.id)
    setFresh((before) => new Set([...before, ...arrived]))
    void markSeen()
  }, [unread, entries, markSeen])

  if (entries.length === 0) return null
  return (
    <section aria-label="From your agents" className="flex flex-col gap-2">
      <h2 className="text-xs font-medium text-muted-foreground">From your agents</h2>
      <ul className="flex flex-col gap-1">
        {entries.map((entry) => (
          <Row key={entry.id} entry={entry} unread={fresh.has(entry.id)} />
        ))}
      </ul>
    </section>
  )
}
