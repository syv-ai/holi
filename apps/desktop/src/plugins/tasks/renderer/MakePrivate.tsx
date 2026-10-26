/**
 * The question "Make private" asks before it renames anything
 * (docs/features/tasks.md). A shared task made private leaves every
 * teammate's board on their next sync, git history keeps the shared version,
 * and shared notes' links to it are left pointing at the shared path, so the
 * person hears all three before the file moves.
 */
import { Button, Dialog } from '@/primitives'

export function MakePrivate({
  title,
  onCancel,
  onConfirm,
}: {
  title: string
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <>
      <Dialog.Header>Make this task private?</Dialog.Header>
      <Dialog.Body>
        <div data-make-private={title} className="grid gap-3 text-xs text-muted-foreground">
          <p>
            <span className="text-foreground">{title}</span> will stay on this machine only. It
            leaves every teammate&apos;s board the next time they sync.
          </p>
          <p>
            Git history keeps the shared version, so anyone with the vault can still find it there.
          </p>
          <p>Links to it from shared notes stop resolving.</p>
        </div>
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" data-make-private-confirm onClick={onConfirm}>
          Make private
        </Button>
      </Dialog.Footer>
    </>
  )
}
