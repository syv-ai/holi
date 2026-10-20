import {
  ChevronsDownUp,
  CircleCheck,
  Ellipsis,
  Eye,
  FolderPlus,
  ListTodo,
  Plus,
} from 'lucide-react'
import type { ClaimCreate } from '@/plugin-api/types'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  IconButton,
} from '@/primitives'

/** What "+" makes: core's kinds, or what a claim makes (an app). Where it
 *  lands is the tree's to decide. */
export type NewKind = 'task' | 'file' | 'folder' | ClaimCreate

/**
 * The explorer's toolbar: one band over the tree with the section's name at
 * its start and two controls at its end (docs/features/sidebar.md): "+" makes
 * a note, and "⋯" holds the rest, making a folder, a task or what a claim
 * makes (an app), the two filters as checkable rows, and Collapse all. Two
 * icons, always there: the everyday act is one press, everything else one
 * menu away.
 */
export function ExplorerHeader({
  label,
  creates = [],
  onNew,
  onCollapseAll,
  hiddenShown,
  onToggleHidden,
  tasksShown,
  onToggleTasks,
}: {
  /** The section's name at the band's start ("Files"). */
  label?: string
  /** What enabled claims add to the menu, after core's own. */
  creates?: readonly ClaimCreate[]
  onNew: (kind: NewKind) => void
  onCollapseAll: () => void
  /** Whether hidden (dot-prefixed) entries are currently shown. */
  hiddenShown: boolean
  onToggleHidden: () => void
  /** Whether task files (`task.*.md`) are shown in the tree. */
  tasksShown: boolean
  onToggleTasks: () => void
}) {
  return (
    <div className="absolute inset-x-2 top-0 z-10 flex h-9 items-center gap-1 ps-2">
      {label !== undefined && (
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {label}
        </span>
      )}
      <span className="ms-auto flex items-center gap-0.5">
        <IconButton icon={Plus} label="New note" quiet onClick={() => onNew('file')} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton icon={Ellipsis} label="File options" quiet />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={() => onNew('folder')}>
              <Icon icon={FolderPlus} size="sm" />
              New folder
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNew('task')}>
              <Icon icon={CircleCheck} size="sm" />
              New task
            </DropdownMenuItem>
            {creates.map((c) => (
              <DropdownMenuItem key={c.id} onSelect={() => onNew(c)}>
                <Icon icon={c.icon} size="sm" />
                {c.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={tasksShown} onCheckedChange={onToggleTasks}>
              <Icon icon={ListTodo} size="sm" />
              Show task files
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={hiddenShown} onCheckedChange={onToggleHidden}>
              <Icon icon={Eye} size="sm" />
              Show hidden files
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onCollapseAll}>
              <Icon icon={ChevronsDownUp} size="sm" />
              Collapse all
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </div>
  )
}
