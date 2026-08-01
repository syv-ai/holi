import { ChevronsDownUp, Eye, EyeOff, FilePlus, FolderPlus, ListTodo } from 'lucide-react'
import { Button } from '@/primitives'

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
      <span className="flex shrink-0 items-center gap-0.5 rounded-md bg-popover/90 px-1 py-0.5 text-muted-foreground shadow-sm ring-1 ring-border backdrop-blur-sm">
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          title="New File"
          aria-label="New File"
          onClick={onNewFile}
        >
          <FilePlus size={15} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          title="New Folder"
          aria-label="New Folder"
          onClick={onNewFolder}
        >
          <FolderPlus size={15} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          title="Collapse All"
          aria-label="Collapse All"
          onClick={onCollapseAll}
        >
          <ChevronsDownUp size={15} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className={`hover:text-foreground ${tasksShown ? 'text-foreground' : 'text-muted-foreground'}`}
          title={tasksShown ? 'Hide task files' : 'Show task files'}
          aria-label={tasksShown ? 'Hide task files' : 'Show task files'}
          aria-pressed={tasksShown}
          onClick={onToggleTasks}
        >
          <ListTodo size={15} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className={`hover:text-foreground ${hiddenShown ? 'text-foreground' : 'text-muted-foreground'}`}
          title={hiddenShown ? 'Hide hidden files' : 'Show hidden files'}
          aria-label={hiddenShown ? 'Hide hidden files' : 'Show hidden files'}
          aria-pressed={hiddenShown}
          onClick={onToggleHidden}
        >
          {hiddenShown ? <Eye size={15} /> : <EyeOff size={15} />}
        </Button>
      </span>
    </div>
  )
}
