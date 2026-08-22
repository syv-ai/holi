/**
 * The FR-12 delete preview, generalized to a set. Names how many external links
 * across how many files will be left dangling (they become tombstones — no
 * cascade), so deleting a file, a folder, or a multi-selection is a decision made
 * with the fallout in view. The caller passes a human `label` and the external
 * `refs` (folder-internal links are already excluded by `backrefsMany`).
 *
 * A composite rather than part of the explorer, because it has two callers now:
 * the file tree deletes paths, the Apps section deletes an app directory, and a
 * feature may only import from its own feature.
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
   * What the confirm button is about to do.
   *
   * Moving a file OUT of the vault removes it from the vault, so it earns this
   * same warning — the links left dangling are identical either way. But it is
   * not a delete, and a dialog that says so would describe the wrong outcome to
   * someone who asked for a move. Defaulted, so every existing caller is
   * unchanged.
   */
  verb?: 'Delete' | 'Move'
}) {
  const total = refs.reduce((n, r) => n + r.count, 0)
  return (
    <Dialog open onClose={onCancel} size="sm">
      <div data-delete-dialog={label} className="grid min-w-0 gap-4 [&>*]:min-w-0">
        <Dialog.Header>
          {/* `break-all`, not `break-words`: this is a path, and every character
              is a place it may legitimately break. `break-words` keeps a long
              unbroken run intact until it has to give, which for
              `AI_&_ML_Anbefalingsbrev_udkast_William_Hvid_Larsen.pdf` means
              one enormous line. */}
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
