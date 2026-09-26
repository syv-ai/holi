/**
 * Triage a thread without opening it (opening marks it read).
 *
 * **Right-click only, no hover `⋯`.** A row's entire area already means "open
 * this", and a second target inside it makes that a coin toss near the right
 * edge. It is the `ContextMenu` primitive fed items: there is no per-surface
 * menu in this codebase (recorded on `ContextMenuContent`).
 *
 * **Nothing here talks to tRPC.** The actions arrive as callbacks from
 * [[MailView]], where they go through `write`: the optimistic paint, the
 * generation check that decides whether an undo is still valid, and the failure
 * message. Without that message a silent revert is indistinguishable from the
 * click never registering.
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
   *  `Thread`: a row only ever has the summary. */
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
      {/* A wrapping element, not `asChild` onto the row itself: the row is a
          plain function component that would swallow Radix's ref, and the
          trigger would silently never bind. */}
      <ContextMenuTrigger asChild>
        <div>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpen}>Open</ContextMenuItem>

        {/* Both directions: the reader's header cannot mark unread, since
            opening a thread is what marks it read. */}
        <ContextMenuItem onSelect={() => actions.setRead(thread.id, thread.unread)}>
          {thread.unread ? 'Mark read' : 'Mark unread'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.setStarred(thread.id, !thread.starred)}>
          {thread.starred ? 'Unstar' : 'Star'}
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onSelect={() => actions.archive(thread.id)}>Archive</ContextMenuItem>
        {/* Trash, which Gmail keeps for 30 days. Not called Delete: Holi cannot
            delete mail permanently and will not request the scope. */}
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
        {/* From the sender's List-Unsubscribe. Opened, never requested: firing
            it silently would hit a URL a stranger chose on the user's behalf. */}
        {thread.unsubscribeUrl !== null && (
          <ContextMenuItem onSelect={() => actions.openExternal(thread.unsubscribeUrl!)}>
            Unsubscribe
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
