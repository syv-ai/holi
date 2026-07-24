/**
 * The FR-12 delete preview: name every file that links here and how many times,
 * so deleting is a decision with the tombstones-to-be in view. An in-app dialog
 * rather than `window.confirm` — the warning is a list, and Electron's native
 * confirm cannot render one.
 */
export function DeleteConfirm({
  path,
  refs,
  onCancel,
  onConfirm,
}: {
  path: string
  refs: { path: string; count: number }[]
  onCancel: () => void
  onConfirm: () => void
}) {
  const total = refs.reduce((n, r) => n + r.count, 0)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        data-delete-dialog={path}
        className="w-80 rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-200 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-2">
          Delete <span className="font-mono text-neutral-100">{path}</span>?
        </p>
        {refs.length === 0 ? (
          <p className="mb-3 text-xs text-neutral-500">Nothing links to it.</p>
        ) : (
          <div className="mb-3">
            <p className="mb-1 text-xs text-neutral-400">
              {total} link{total === 1 ? '' : 's'} in {refs.length} file
              {refs.length === 1 ? '' : 's'} will be left dangling (they become tombstones — no
              cascade):
            </p>
            <ul className="max-h-40 overflow-y-auto text-xs">
              {refs.map((r) => (
                <li key={r.path} className="flex justify-between font-mono text-neutral-300">
                  <span className="truncate">{r.path}</span>
                  <span className="ml-2 shrink-0 text-neutral-500">×{r.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            data-delete-confirm={path}
            className="rounded bg-red-900/60 px-2 py-1 text-xs text-red-200 hover:bg-red-900"
            onClick={onConfirm}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
