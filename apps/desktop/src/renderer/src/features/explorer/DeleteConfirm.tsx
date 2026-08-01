/**
 * The FR-12 delete preview, generalized to a set. Names how many external links
 * across how many files will be left dangling (they become tombstones — no
 * cascade), so deleting a file, a folder, or a multi-selection is a decision made
 * with the fallout in view. The caller passes a human `label` and the external
 * `refs` (folder-internal links are already excluded by `backrefsMany`).
 */
import { Button, Dialog } from '@/primitives'

export function DeleteConfirm({
  label,
  refs,
  onCancel,
  onConfirm,
}: {
  label: string
  refs: { path: string; count: number }[]
  onCancel: () => void
  onConfirm: () => void
}) {
  const total = refs.reduce((n, r) => n + r.count, 0)
  return (
    <Dialog open onClose={onCancel} size="sm">
      <div data-delete-dialog={label} className="grid gap-4">
        <Dialog.Header>
          Delete <span className="font-mono">{label}</span>?
        </Dialog.Header>
        <Dialog.Body>
          {refs.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing links to it.</p>
          ) : (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">
                {total} link{total === 1 ? '' : 's'} in {refs.length} file
                {refs.length === 1 ? '' : 's'} will be left dangling (they become tombstones — no
                cascade):
              </p>
              <ul className="max-h-40 overflow-y-auto text-xs">
                {refs.map((r) => (
                  <li key={r.path} className="flex justify-between font-mono text-muted-foreground">
                    <span className="truncate">{r.path}</span>
                    <span className="ml-2 shrink-0 text-muted-foreground">×{r.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Dialog.Body>
        <Dialog.Footer>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" data-delete-confirm={label} onClick={onConfirm}>
            Delete
          </Button>
        </Dialog.Footer>
      </div>
    </Dialog>
  )
}
