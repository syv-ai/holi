/**
 * Triage a thread without opening it.
 *
 * Every verb here already existed in the reader's header, and every one of them
 * cost an open first — which for archiving a newsletter is exactly backwards:
 * the whole reason it is being archived is that you do not want to read it, and
 * opening it marks it read on the way past.
 *
 * **Right-click only, no hover `⋯`.** A row's entire area already means one
 * thing — open this — and a second target inside it makes that one thing a
 * coin toss near the right edge. The context menu is where the app already puts
 * per-row actions ([[FileTree]]) and it costs the row nothing.
 *
 * It is the `ContextMenu` primitive fed items, not a menu component of its own:
 * there is no per-surface menu in this codebase (decided 2026-08-01, recorded on
 * `ContextMenuContent`).
 *
 * **Nothing here talks to tRPC.** The actions arrive as callbacks from
 * [[MailView]], where they go through `write` — the optimistic paint, the
 * generation check that decides whether an undo is still valid, and the failure
 * message. A menu that called Google directly would need its own copy of all
 * three, and the last one is not optional: a silent revert is indistinguishable
 * from the click never registering, which is precisely how a missing
 * `gmail.modify` grant presented in real use.
 */
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/primitives'

/** What a thread can have done to it. Named as a bundle because the row menu
 *  and the selection bar both want the same set. */
export interface ThreadActions {
  setRead: (id: string, read: boolean) => void
  setStarred: (id: string, starred: boolean) => void
  archive: (id: string) => void
  trash: (id: string) => void
  /** Takes the two fields a task link is built from, rather than a whole
   *  `Thread` — a row only ever has the summary, and fetching the thread to
   *  read a subject already in hand would be a request spent on nothing. */
  linkToTask: (thread: { subject: string; webUrl: string }) => void
  /** False with no vault open, which is when a task has nowhere to be written. */
  canLinkToTask: boolean
  openExternal: (url: string) => void
}

/** The subset of a row this menu needs. Deliberately structural rather than
 *  `ThreadSummary`, so the menu does not depend on the whole list shape. */
export interface MenuThread {
  id: string
  subject: string
  webUrl: string
  unread: boolean
  starred: boolean
  unsubscribeUrl: string | null
}

export function ThreadMenu({
  thread,
  actions,
  onOpen,
  children,
}: {
  thread: MenuThread
  actions: ThreadActions
  onOpen: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <ContextMenu>
      {/* A wrapping element, not `asChild` onto the row itself.
          `asChild` hands Radix's ref to whatever it is given, and the row is a
          plain function component — it would swallow that ref, and the trigger
          would silently never bind. A `div` takes the ref natively, and the row
          is `w-full` inside it, so it costs no layout. */}
      <ContextMenuTrigger asChild>
        <div>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpen}>Open</ContextMenuItem>

        {/* Both directions, because putting a thread back on the pile is a real
            move and the one the reader's header cannot express at all — opening
            a thread is what marks it read. */}
        <ContextMenuItem onSelect={() => actions.setRead(thread.id, thread.unread)}>
          {thread.unread ? 'Mark read' : 'Mark unread'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.setStarred(thread.id, !thread.starred)}>
          {thread.starred ? 'Unstar' : 'Star'}
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onSelect={() => actions.archive(thread.id)}>Archive</ContextMenuItem>
        {/* Trash, which Gmail keeps for 30 days. Deliberately not called Delete:
            Holi cannot delete mail permanently — the scope is not requested and
            will not be — and a menu entry saying Delete would promise something
            it has no way to do. */}
        <ContextMenuItem variant="destructive" onSelect={() => actions.trash(thread.id)}>
          Move to trash
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem
          disabled={!actions.canLinkToTask}
          onSelect={() => actions.linkToTask(thread)}
        >
          Link to task
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.openExternal(thread.webUrl)}>
          Open in Gmail
        </ContextMenuItem>
        {/* Advertised by the sender in List-Unsubscribe, and only offered when
            they advertised one. Opened, never requested: firing it silently
            would be a request made on the user's behalf to a URL a stranger
            chose. */}
        {thread.unsubscribeUrl !== null && (
          <ContextMenuItem onSelect={() => actions.openExternal(thread.unsubscribeUrl!)}>
            Unsubscribe
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
