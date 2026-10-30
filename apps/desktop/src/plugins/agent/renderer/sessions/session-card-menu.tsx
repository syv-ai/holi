/**
 * A card's menus and what hangs off them: right-click, the ⋯ button, Rename in
 * place and Delete asked first (docs/features/agent-sessions.md, The Agents
 * view).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CircleDotIcon,
  Columns2Icon,
  CopyIcon,
  CopyPlusIcon,
  EllipsisIcon,
  FileDiffIcon,
  MailCheckIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  RotateCwIcon,
  SquareIcon,
  SquareTerminalIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useRef } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/composites/confirm-dialog'
import { openTabAtom } from '@/plugin-api'
import {
  duplicateSessionAtom,
  openConversationTerminalAtom,
  openSessionAtom,
  respawnSessionAtom,
  stopSessionAtom,
} from '../state/send'
import {
  archiveSessionRowAtom,
  deleteSessionRowAtom,
  keyOwner,
  markSessionSeenAtom,
  markSessionUnreadAtom,
  pinSessionRowAtom,
  renameSessionRowAtom,
  rowAbilitiesAtom,
  type SessionRow,
} from '../state/session-list'
import { agentSessionsAtom } from '../state/sessions'
import { reviewSessionTurnAtom } from '../state/turns'
import { rowSelection } from './session-card'

/**
 * A card's menu, written once and drawn twice: as its right-click menu and as
 * the ⋯ button's dropdown, the keyboard's way to the same actions (after the
 * documents tree's). Each item is there only when something backs it: the
 * row's owner (its slot's `rename`, `pin`, `archive`, `remove`), this
 * machine's read state, or the live session's own verbs.
 */
type MenuAction =
  | {
      kind: 'item'
      label: string
      icon: React.ReactNode
      destructive?: boolean
      run: () => void
    }
  | { kind: 'separator' }

function ContextMenuActions({ actions }: { actions: MenuAction[] }) {
  return actions.map((action, index) =>
    action.kind === 'separator' ? (
      <ContextMenuSeparator key={index} />
    ) : (
      <ContextMenuItem
        key={index}
        variant={action.destructive ? 'destructive' : 'default'}
        onSelect={action.run}
      >
        {action.icon}
        {action.label}
      </ContextMenuItem>
    ),
  )
}

function DropdownMenuActions({ actions }: { actions: MenuAction[] }) {
  return actions.map((action, index) =>
    action.kind === 'separator' ? (
      <DropdownMenuSeparator key={index} />
    ) : (
      <DropdownMenuItem
        key={index}
        variant={action.destructive ? 'destructive' : 'default'}
        onSelect={action.run}
      >
        {action.icon}
        {action.label}
      </DropdownMenuItem>
    ),
  )
}

/** Groups of items, with a separator between the groups that have any. */
function joinGroups(groups: MenuAction[][]): MenuAction[] {
  return groups
    .filter((g) => g.length > 0)
    .flatMap((g, i) => (i === 0 ? g : [{ kind: 'separator' as const }, ...g]))
}

/** What a row's menu offers, as data both menus draw. */
function useRowActions(
  row: SessionRow,
  {
    onRename,
    onDelete,
    onClose,
  }: { onRename: () => void; onDelete: () => void; onClose?: () => void },
): MenuAction[] {
  const live = useAtomValue(agentSessionsAtom)
  const abilities = useAtomValue(rowAbilitiesAtom)
  const stop = useSetAtom(stopSessionAtom)
  const respawn = useSetAtom(respawnSessionAtom)
  const duplicate = useSetAtom(duplicateSessionAtom)
  const openFork = useSetAtom(openConversationTerminalAtom)
  const attach = useSetAtom(openSessionAtom)
  const archive = useSetAtom(archiveSessionRowAtom)
  const pin = useSetAtom(pinSessionRowAtom)
  const markRead = useSetAtom(markSessionSeenAtom)
  const markUnread = useSetAtom(markSessionUnreadAtom)
  const openTab = useSetAtom(openTabAtom)
  const reviewTurn = useSetAtom(reviewSessionTurnAtom)
  const { item, state } = row
  const can = abilities.get(keyOwner(item.key))
  const jobId = item.jobId
  const liveSession = live.find((s) => s.id === jobId)
  const isLive = liveSession !== undefined
  // Claude's supervised sessions have a terminal to attach and restart.
  // A Pi RPC job has neither; Pi's separate native PTY session does.
  const background = liveSession?.provider === 'claude'
  const piRpc = (liveSession?.provider ?? item.agent) === 'pi' && jobId?.length === 8
  const sessionId = item.sessionId ?? jobId
  const icon = (Glyph: typeof PinIcon) => <Glyph aria-hidden="true" />

  // A row that selects something, or a live session, can be a tab of its
  // own beside the one in front.
  const selection = rowSelection(item, isLive)
  const place: MenuAction[] =
    selection === undefined
      ? []
      : [
          {
            kind: 'item',
            label: 'Open to the side',
            icon: icon(Columns2Icon),
            run: () => {
              markRead(item.key)
              openTab({ kind: 'session', ...selection }, { beside: true })
            },
          },
        ]
  // Claude Code's own TUI on it: a copy of the conversation by its id, or a
  // live background run itself.
  const conversationId = item.sessionId
  if (!piRpc && conversationId !== undefined) {
    place.push({
      kind: 'item',
      label: 'Open in terminal',
      icon: icon(SquareTerminalIcon),
      run: () => void openFork(conversationId),
    })
  } else if (isLive && jobId !== undefined && !piRpc) {
    place.push({
      kind: 'item',
      label: 'Open in terminal',
      icon: icon(SquareTerminalIcon),
      run: () => void attach(jobId),
    })
  }

  const own: MenuAction[] = []
  if (can?.pin) {
    own.push({
      kind: 'item',
      label: item.pinned ? 'Unpin' : 'Pin to top',
      icon: icon(item.pinned ? PinOffIcon : PinIcon),
      run: () => void pin({ key: item.key, pinned: item.pinned !== true }),
    })
  }
  if (can?.rename) {
    own.push({
      kind: 'item',
      label: 'Rename',
      icon: icon(PencilIcon),
      run: onRename,
    })
  }
  // Read state is this machine's, for any row; one that is working or
  // waiting on you is neither.
  if (state === 'done') {
    own.push({
      kind: 'item',
      label: 'Mark as read',
      icon: icon(MailCheckIcon),
      run: () => markRead(item.key),
    })
  } else if (state === 'idle' && !row.current) {
    own.push({
      kind: 'item',
      label: 'Mark as unread',
      icon: icon(CircleDotIcon),
      run: () => markUnread(item.key),
    })
  }
  if (sessionId !== undefined) {
    own.push({
      kind: 'item',
      label: 'Copy session ID',
      icon: icon(CopyIcon),
      run: () => void navigator.clipboard?.writeText(sessionId),
    })
  }

  const running: MenuAction[] = []
  if (onClose !== undefined) {
    running.push({
      kind: 'item',
      label: 'Close session',
      icon: icon(XIcon),
      run: onClose,
    })
  }
  if (jobId !== undefined) {
    // The turn review, which the session's own view (its terminal) has no
    // room for.
    running.push({
      kind: 'item',
      label: 'Review last turn',
      icon: icon(FileDiffIcon),
      run: () =>
        void reviewTurn(jobId).then((found) => {
          if (!found) toast('No turn of this session is on record yet.')
        }),
    })
  }
  if (isLive && jobId !== undefined) {
    if (background) {
      running.push(
        {
          kind: 'item',
          label: 'Restart',
          icon: icon(RotateCwIcon),
          run: () => void respawn(jobId),
        },
        {
          kind: 'item',
          label: 'Duplicate',
          icon: icon(CopyPlusIcon),
          run: () => void duplicate(jobId),
        },
      )
    }
    running.push({
      kind: 'item',
      label: 'Stop session',
      icon: icon(SquareIcon),
      destructive: true,
      run: () => void stop(jobId),
    })
  }

  const keep: MenuAction[] = []
  if (can?.archive) {
    keep.push({
      kind: 'item',
      label: item.archived === true ? 'Unarchive' : 'Archive',
      icon: icon(item.archived === true ? ArchiveRestoreIcon : ArchiveIcon),
      run: () => void archive({ key: item.key, archived: item.archived !== true }),
    })
  }
  if (can?.remove) {
    keep.push({
      kind: 'item',
      label: 'Delete…',
      icon: icon(Trash2Icon),
      destructive: true,
      run: onDelete,
    })
  }
  return joinGroups([place, own, running, keep])
}

/** A card with its menus: right-click, and ⋯ on hover or focus; and, for an
 *  open one, its × beside the ⋯. */
export function CardWithMenu({
  row,
  renaming,
  onRename,
  onRenamed,
  onDelete,
  onClose,
  closable,
  children,
}: {
  row: SessionRow
  renaming: boolean
  onRename: () => void
  onRenamed: () => void
  onDelete: () => void
  /** Close it in the Sessions list: only an open card has one. */
  onClose?: () => void
  /** Show the × beside the ⋯, not only Close in the menu. */
  closable: boolean
  children: React.ReactNode
}): React.JSX.Element {
  // A Rename picked in a menu opens the field once the menu has closed, so
  // the menu handing focus back does not blur it shut again.
  const renameNext = useRef(false)
  const actions = useRowActions(row, {
    onRename: () => {
      renameNext.current = true
    },
    onDelete,
    onClose,
  })
  const closeAutoFocus = (event: Event) => {
    if (!renameNext.current) return
    renameNext.current = false
    event.preventDefault()
    onRename()
  }
  if (renaming) return <RenameField row={row} onDone={onRenamed} />
  if (actions.length === 0) return <>{children}</>
  return (
    <div className="group/card relative" data-session-row={row.item.key}>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent
          className="w-52"
          onCloseAutoFocus={(e) => {
            if (renameNext.current) closeAutoFocus(e)
            else e.preventDefault()
          }}
        >
          <ContextMenuActions actions={actions} />
        </ContextMenuContent>
      </ContextMenu>
      {/* Shown on hover or focus, and while a menu is open. */}
      <div className="absolute end-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 motion-respond focus-within:opacity-100 group-focus-within/card:opacity-100 group-hover/card:opacity-100 has-data-[state=open]:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`More actions for ${row.item.title}`}
            >
              <EllipsisIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52" onCloseAutoFocus={closeAutoFocus}>
            <DropdownMenuActions actions={actions} />
          </DropdownMenuContent>
        </DropdownMenu>
        {closable && onClose !== undefined && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Close ${row.item.title}`}
            onClick={onClose}
          >
            <XIcon aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  )
}

/** The card's title as a field: Enter saves, Escape cancels, and leaving it
 *  saves, as the documents tree's rename does. */
function RenameField({ row, onDone }: { row: SessionRow; onDone: () => void }): React.JSX.Element {
  const rename = useSetAtom(renameSessionRowAtom)
  const done = useRef(false)
  const finish = (value: string | null) => {
    if (done.current) return
    done.current = true
    const title = value?.trim() ?? ''
    if (title !== '' && title !== row.item.title) {
      void rename({ key: row.item.key, title })
    }
    onDone()
  }
  return (
    <div className="px-1 py-1">
      <Input
        autoFocus
        defaultValue={row.item.title}
        aria-label={`Rename ${row.item.title}`}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            finish(e.currentTarget.value)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            finish(null)
          }
        }}
        onBlur={(e) => finish(e.currentTarget.value)}
      />
    </div>
  )
}

/** Delete, asked first: it names the session and says what stays. */
export function DeleteDialog({
  row,
  onClose,
}: {
  row: SessionRow | null
  onClose: () => void
}): React.JSX.Element {
  const remove = useSetAtom(deleteSessionRowAtom)
  // A failure rejects, so the dialog stays open and shows it inline.
  const confirm = async () => {
    if (row === null) return
    const res = (await remove(row.item.key)) as
      { ok: true } | { ok: false; message: string } | undefined
    if (res !== undefined && !res.ok) throw new Error(res.message)
  }
  return (
    <ConfirmDialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={`Delete “${row?.item.title ?? ''}”?`}
      description="Holi forgets this conversation on this machine: its row and Holi’s copy of the transcript. Claude Code’s own transcript stays where Claude Code keeps it."
      confirmLabel="Delete"
      destructive
      onConfirm={confirm}
    />
  )
}
