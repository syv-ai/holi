import { ChevronsDownUp, Eye, EyeOff, FilePlus, FolderPlus } from 'lucide-react'

/** The explorer's action strip: the vault name and the VS Code header actions.
 *  Icons are from lucide-react (the app's icon set). */
export function ExplorerHeader({
  title,
  onNewFile,
  onNewFolder,
  onCollapseAll,
  hiddenShown,
  onToggleHidden,
}: {
  title: string
  onNewFile: () => void
  onNewFolder: () => void
  onCollapseAll: () => void
  /** Whether hidden (dot-prefixed) entries are currently shown. */
  hiddenShown: boolean
  onToggleHidden: () => void
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1">
      <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </span>
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
