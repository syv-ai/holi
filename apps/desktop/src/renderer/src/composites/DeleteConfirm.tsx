/**
 * The delete preview for a set of paths (docs/features/file-tree.md). Names how
 * many external links across how many files will be left dangling (no
 * cascade). The caller passes a human `label` and the external `refs`
 * (folder-internal links are already excluded by `backrefsMany`).
 *
 * A composite because the file tree and the Apps section both use it.
 */
import { Button, Dialog } from '@/primitives'

export function DeleteConfirm({
  label,
  refs,
  onCancel,
  onConfirm,
  verb = 'Delete',
}: {
  label: string
  refs: { path: string; count: number }[]
  onCancel: () => void
  onConfirm: () => void
  /**
   * What the confirm button is about to do. Moving a file out of the vault
   * leaves the same dangling links but is not a delete, so it says so.
   */
  verb?: 'Delete' | 'Move'
}) {
  const total = refs.reduce((n, r) => n + r.count, 0)
  return (
    <Dialog open onClose={onCancel} size="sm">
      <div data-delete-dialog={label} className="grid min-w-0 gap-4 [&>*]:min-w-0">
        <Dialog.Header>
          {/* `break-all`, not `break-words`: a path may break anywhere, and
              `break-words` leaves a long unbroken filename as one line. */}
          {verb} <span className="break-all font-mono">{label}</span>?
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
            {verb}
          </Button>
        </Dialog.Footer>
      </div>
    </Dialog>
  )
}
