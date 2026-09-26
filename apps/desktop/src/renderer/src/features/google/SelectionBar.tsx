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
import { Button, Tooltip } from '@/primitives'

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
        <Tooltip content="mark read">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="mark read"
            onClick={() => onSetRead(true)}
          >
            <MailOpen size={14} />
          </Button>
        </Tooltip>
        <Tooltip content="mark unread">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="mark unread"
            onClick={() => onSetRead(false)}
          >
            <Mail size={14} />
          </Button>
        </Tooltip>
        <Tooltip content="star">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="star"
            onClick={() => onSetStarred(true)}
          >
            <Star size={14} />
          </Button>
        </Tooltip>
        <Tooltip content="unstar">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="unstar"
            onClick={() => onSetStarred(false)}
          >
            <StarOff size={14} />
          </Button>
        </Tooltip>
        <Tooltip content="archive — removes them from the inbox, keeps them in All Mail">
          <Button variant="ghost" size="icon-xs" aria-label="archive" onClick={onArchive}>
            <Archive size={14} />
          </Button>
        </Tooltip>
        {/* Trash, which Gmail keeps for 30 days. Not called Delete: Holi cannot
            delete mail permanently and will not request the scope that would
            let it. */}
        <Tooltip content="move to trash — recoverable for 30 days">
          <Button variant="ghost" size="icon-xs" aria-label="move to trash" onClick={onTrash}>
            <Trash2 size={14} />
          </Button>
        </Tooltip>
        <Tooltip content="clear selection (Esc)">
          <Button variant="ghost" size="icon-xs" aria-label="clear selection" onClick={onClear}>
            <X size={14} />
          </Button>
        </Tooltip>
      </div>
    </div>
  )
}
