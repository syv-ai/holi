import { ChevronsDownUp, Eye, EyeOff, FilePlus, FolderPlus, ListTodo } from 'lucide-react'
import { Button, Tooltip } from '@/primitives'
import { cn } from '@/lib/cn'

/** One explorer toolbar action: a ghost icon button with the house tooltip (its
 *  `label` is both the tooltip and the accessible name). `active` renders the
 *  pressed state for the toggles; omit it for the plain actions. */
function Action({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip content={label}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        aria-pressed={active}
        className={cn(
          'hover:text-foreground',
          active ? 'text-foreground' : 'text-muted-foreground',
        )}
        onClick={onClick}
      >
        {icon}
      </Button>
    </Tooltip>
  )
}

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
    <div className="motion-respond pointer-events-none absolute right-3 top-1 z-10 opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/explorer:pointer-events-auto group-hover/explorer:opacity-100">
      <span className="flex shrink-0 items-center gap-0.5 rounded-md bg-popover/90 px-1 py-0.5 text-muted-foreground shadow-sm ring-1 ring-border backdrop-blur-sm">
        <Action icon={<FilePlus size={15} />} label="New File" onClick={onNewFile} />
        <Action icon={<FolderPlus size={15} />} label="New Folder" onClick={onNewFolder} />
        <Action icon={<ChevronsDownUp size={15} />} label="Collapse All" onClick={onCollapseAll} />
        <Action
          icon={<ListTodo size={15} />}
          label={tasksShown ? 'Hide task files' : 'Show task files'}
          active={tasksShown}
          onClick={onToggleTasks}
        />
        <Action
          icon={hiddenShown ? <Eye size={15} /> : <EyeOff size={15} />}
          label={hiddenShown ? 'Hide hidden files' : 'Show hidden files'}
          active={hiddenShown}
          onClick={onToggleHidden}
        />
      </span>
    </div>
  )
}
