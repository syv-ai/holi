/**
 * The agent inbox tab (docs/features/agent-inbox.md): what the agent told you
 * with `holi agent notify`, and the sessions that needed you, newest first.
 * A row opens its note or session; its X dismisses it. Looking at the tab
 * reads everything in it, which clears the nav item's count.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, IconButton } from '@/primitives'
import { cn } from '@/plugin-api'
import {
  dismissInboxEntryAtom,
  inboxAtom,
  markInboxSeenAtom,
  openInboxEntryAtom,
  type InboxEntry,
} from './state/inbox'

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
    <li className="group/row relative flex items-center" data-inbox-entry={entry.id}>
      <Button
        variant="ghost"
        size="sm"
        className="h-auto w-full flex-col items-start gap-0.5 px-2 py-1.5 pr-9 text-left font-normal"
        disabled={!opens}
        onClick={() => open(entry)}
      >
        <span className="flex w-full items-baseline gap-3">
          <span className={cn('truncate', unread && 'font-medium')}>{entry.title}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{when(entry.at)}</span>
        </span>
        {entry.line !== '' && (
          <span className="w-full whitespace-normal text-muted-foreground">{entry.line}</span>
        )}
        {entry.path !== undefined && (
          <span className="w-full truncate font-mono text-xs text-muted-foreground">
            {entry.path}
          </span>
        )}
      </Button>
      <IconButton
        icon={X}
        label="Dismiss"
        size="sm"
        className="absolute right-1 top-1 opacity-0 focus-visible:opacity-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100"
        onClick={() => void dismiss(entry.id)}
      />
    </li>
  )
}

export function InboxView({ visible }: { visible: boolean }): React.JSX.Element {
  const { entries, unread } = useAtomValue(inboxAtom)
  const markSeen = useSetAtom(markInboxSeenAtom)
  // The entries that were unread when they came into view: they stay marked
  // while the tab is in front, though the count has gone. By id, so a
  // dismissed row does not pass its mark to the next.
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set())

  // What arrives while the tab is in front is seen as it arrives. The unread
  // ones are the newest: the list is newest first.
  useEffect(() => {
    if (!visible) setFresh(new Set())
    else if (unread > 0) {
      const arrived = entries.slice(0, unread).map((e) => e.id)
      setFresh((before) => new Set([...before, ...arrived]))
      void markSeen()
    }
  }, [visible, unread, entries, markSeen])

  return (
    <div className="flex flex-1 justify-center overflow-y-auto px-4 py-8 text-sm">
      <section className="w-full max-w-[32rem]">
        <h2 className="mb-2 text-xs font-medium text-muted-foreground">Inbox</h2>
        {entries.length === 0 ? (
          <p className="text-muted-foreground">
            Nothing needs you. The agent leaves a note here when something does.
          </p>
        ) : (
          <ul className="-mx-2 flex flex-col gap-0.5">
            {entries.map((entry) => (
              <Row key={entry.id} entry={entry} unread={fresh.has(entry.id)} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
