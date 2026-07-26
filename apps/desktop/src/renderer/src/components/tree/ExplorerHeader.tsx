import { ChevronsDownUp, Eye, EyeOff, FilePlus, FolderPlus } from 'lucide-react'

/** The explorer's action strip (the vault name lives in the picker above, not
 *  here). Icons are from lucide-react (the app's icon set). */
export function ExplorerHeader({
  onNewFile,
  onNewFolder,
  onCollapseAll,
  hiddenShown,
  onToggleHidden,
}: {
  onNewFile: () => void
  onNewFolder: () => void
  onCollapseAll: () => void
  /** Whether hidden (dot-prefixed) entries are currently shown. */
  hiddenShown: boolean
  onToggleHidden: () => void
}) {
  return (
    <div className="flex items-center justify-end px-2 py-1">
      <span className="flex shrink-0 gap-0.5 text-neutral-500">
        <button
          className="rounded p-1 hover:bg-neutral-800 hover:text-neutral-200"
          title="New File"
          aria-label="New File"
          onClick={onNewFile}
        >
          <FilePlus size={15} />
        </button>
        <button
          className="rounded p-1 hover:bg-neutral-800 hover:text-neutral-200"
          title="New Folder"
          aria-label="New Folder"
          onClick={onNewFolder}
        >
          <FolderPlus size={15} />
        </button>
        <button
          className="rounded p-1 hover:bg-neutral-800 hover:text-neutral-200"
          title="Collapse All"
          aria-label="Collapse All"
          onClick={onCollapseAll}
        >
          <ChevronsDownUp size={15} />
        </button>
        <button
          className={`rounded p-1 hover:bg-neutral-800 hover:text-neutral-200 ${
            hiddenShown ? 'text-neutral-200' : ''
          }`}
          title={hiddenShown ? 'Hide hidden files' : 'Show hidden files'}
          aria-label={hiddenShown ? 'Hide hidden files' : 'Show hidden files'}
          aria-pressed={hiddenShown}
          onClick={onToggleHidden}
        >
          {hiddenShown ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
      </span>
    </div>
  )
}
