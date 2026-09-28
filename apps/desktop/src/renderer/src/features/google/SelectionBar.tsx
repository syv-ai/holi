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
import { IconButton } from '@/primitives'

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
    <div className="flex h-11 shrink-0 items-center gap-1 bg-secondary px-2">
      <span className="shrink-0 text-xs font-medium tabular-nums">{count} selected</span>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {/* Both directions of both toggles, spelled out rather than derived:
            a mixed selection has no "current" state to flip. */}
        <IconButton icon={MailOpen} label="mark read" onClick={() => onSetRead(true)} />
        <IconButton icon={Mail} label="mark unread" onClick={() => onSetRead(false)} />
        <IconButton icon={Star} label="star" onClick={() => onSetStarred(true)} />
        <IconButton icon={StarOff} label="unstar" onClick={() => onSetStarred(false)} />
        <IconButton
          icon={Archive}
          label="archive"
          tooltip="archive — removes them from the inbox, keeps them in All Mail"
          onClick={onArchive}
        />
        {/* Trash, which Gmail keeps for 30 days. Not called Delete: Holi cannot
            delete mail permanently and will not request the scope that would
            let it. */}
        <IconButton
          icon={Trash2}
          label="move to trash"
          tooltip="move to trash — recoverable for 30 days"
          onClick={onTrash}
        />
        <IconButton
          icon={X}
          label="clear selection"
          tooltip="clear selection (Esc)"
          onClick={onClear}
        />
      </div>
    </div>
  )
}
