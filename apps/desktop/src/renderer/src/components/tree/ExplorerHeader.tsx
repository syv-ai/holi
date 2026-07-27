import { ChevronsDownUp, Eye, EyeOff, FilePlus, FolderPlus, ListTodo } from 'lucide-react'

/** The explorer's action buttons. Hidden until the tree is hovered (or focused),
 *  then floated in as a small toolbar in the top-right — VS Code's section-action
 *  pattern. The parent FileTree carries `group/explorer`. Icons are lucide. */
export function ExplorerHeader({
  onNewFile,
  onNewFolder,
  onCollapseAll,
  hiddenShown,
  onToggleHidden,
  tasksShown,
  onToggleTasks,
}: {
  onNewFile: () => void
  onNewFolder: () => void
  onCollapseAll: () => void
  /** Whether hidden (dot-prefixed) entries are currently shown. */
  hiddenShown: boolean
  onToggleHidden: () => void
  /** Whether task files (`task.*.md`) are shown in the tree. */
  tasksShown: boolean
  onToggleTasks: () => void
}) {
  return (
    <div className="pointer-events-none absolute right-3 top-1 z-10 opacity-0 transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/explorer:pointer-events-auto group-hover/explorer:opacity-100">
      <span className="flex shrink-0 items-center gap-0.5 rounded-md bg-neutral-900/90 px-1 py-0.5 text-neutral-400 shadow-sm ring-1 ring-neutral-800/60 backdrop-blur-sm">
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
            tasksShown ? 'text-neutral-200' : ''
          }`}
          title={tasksShown ? 'Hide task files' : 'Show task files'}
          aria-label={tasksShown ? 'Hide task files' : 'Show task files'}
          aria-pressed={tasksShown}
          onClick={onToggleTasks}
        >
          <ListTodo size={15} />
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
