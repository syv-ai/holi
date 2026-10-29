/**
 * What you can do to several threads at once.
 *
 * It **replaces** the toolbar rather than sitting under it: search, the
 * mailbox picker and refresh would all silently invalidate the selection.
 *
 * **Every action is N per-thread writes, not a bulk endpoint**, deliberately:
 * each write goes through [[MailView]]'s `write`, which owns the optimistic
 * paint, the undo generation check, and `explainWriteFailure`. A partial
 * failure then comes for free: the ones that succeeded stay moved, one message
 * explains the rest, and the list re-reads.
 */
import { Archive, MailOpen, Mail, Star, StarOff, Trash2, X } from 'lucide-react'
import { IconButton } from '@/composites/icon-button'
import { PaneToolbar } from '@/composites/pane-toolbar'

export function SelectionBar({
  count,
  onSetRead,
  onSetStarred,
  onArchive,
  onTrash,
  onClear,
}: {
  count: number
  onSetRead: (read: boolean) => void
  onSetStarred: (starred: boolean) => void
  onArchive: () => void
  onTrash: () => void
  onClear: () => void
}): React.JSX.Element {
  return (
    <PaneToolbar className="bg-secondary">
      <span className="shrink-0 text-xs font-medium tabular-nums">{count} selected</span>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {/* Both directions of both toggles, spelled out rather than derived:
            a mixed selection has no "current" state to flip. */}
        <IconButton label="Mark read" onClick={() => onSetRead(true)}>
          <MailOpen className="size-3.5" />
        </IconButton>
        <IconButton label="Mark unread" onClick={() => onSetRead(false)}>
          <Mail className="size-3.5" />
        </IconButton>
        <IconButton label="Star" onClick={() => onSetStarred(true)}>
          <Star className="size-3.5" />
        </IconButton>
        <IconButton label="Unstar" onClick={() => onSetStarred(false)}>
          <StarOff className="size-3.5" />
        </IconButton>
        <IconButton
          label="Archive: removes them from the inbox, keeps them in All Mail"
          aria-label="Archive"
          onClick={onArchive}
        >
          <Archive className="size-3.5" />
        </IconButton>
        {/* Trash, which Gmail keeps for 30 days. Not called Delete: Holi cannot
            delete mail permanently and will not request the scope that would
            let it. */}
        <IconButton
          label="Move to trash: recoverable for 30 days"
          aria-label="Move to trash"
          onClick={onTrash}
        >
          <Trash2 className="size-3.5" />
        </IconButton>
        <IconButton label="Clear selection (Esc)" aria-label="Clear selection" onClick={onClear}>
          <X className="size-3.5" />
        </IconButton>
      </div>
    </PaneToolbar>
  )
}
