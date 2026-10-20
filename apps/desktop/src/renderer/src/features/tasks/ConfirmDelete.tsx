/**
 * The board's one confirmation before deleting: a card's Delete, or the Done
 * column's Delete every done task. Git keeps what it deletes, so it says so.
 */
import { Button, Dialog } from '@/primitives'

export function ConfirmDelete({
  open,
  title,
  onCancel,
  onConfirm,
}: {
  open: boolean
  /** The question: "Delete Fix login?", "Delete 4 done tasks?". */
  title: string
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onClose={onCancel} size="sm" closable={false}>
      <Dialog.Header>{title}</Dialog.Header>
      <Dialog.Body>
        <p className="text-sm text-muted-foreground">
          Git keeps its history, so it can be restored.
        </p>
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={() => {
            onConfirm()
            onCancel()
          }}
        >
          Delete
        </Button>
      </Dialog.Footer>
    </Dialog>
  )
}
