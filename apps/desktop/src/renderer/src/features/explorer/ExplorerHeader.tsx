import {
  ChevronsDownUp,
  CircleCheck,
  Eye,
  EyeOff,
  FilePlus,
  FolderPlus,
  ListTodo,
  Plus,
} from 'lucide-react'
import { useMemo, useRef } from 'react'
import type { ClaimCreate } from '@/plugin-api/types'
import { MorphingMenu, type MorphingMenuItem } from '@/primitives'

/** What "+" makes: core's kinds, or what a claim makes (an app). Where it
 *  lands is the tree's to decide. */
export type NewKind = 'task' | 'file' | 'folder' | ClaimCreate

/**
 * The explorer's toolbar: the nav menu's morphing menu, anchored at the tree's
 * top-right and opening downward. "+" unfolds into what can be made; Collapse
 * All and the two filters are shortcuts, the filters pressed while on. Icons
 * on the page's background, so the rows under them do not show through, shown
 * while the tree is hovered or anything in the menu has focus,
 * and kept while the menu is open. The parent FileTree carries `group/explorer`.
 */
export function ExplorerHeader({
  creates = [],
  onNew,
  onCollapseAll,
  hiddenShown,
  onToggleHidden,
  tasksShown,
  onToggleTasks,
}: {
  /** What enabled claims add to "+", after core's own. */
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
  // The menu restarts its layout pass when its items change identity, so the
  // items depend on the two states and what claims make only, and call the
  // latest handlers.
  const handlers = useRef({ onNew, onCollapseAll, onToggleHidden, onToggleTasks })
  handlers.current = { onNew, onCollapseAll, onToggleHidden, onToggleTasks }

  const items = useMemo((): MorphingMenuItem[] => {
    const make = (kind: NewKind) => () => handlers.current.onNew(kind)
    return [
      {
        id: 'new',
        label: 'New',
        icon: Plus,
        children: [
          {
            id: 'new-task',
            label: 'New Task',
            icon: CircleCheck,
            onSelect: make('task'),
          },
          {
            id: 'new-file',
            label: 'New File',
            icon: FilePlus,
            onSelect: make('file'),
          },
          {
            id: 'new-folder',
            label: 'New Folder',
            icon: FolderPlus,
            onSelect: make('folder'),
          },
          ...creates.map((c) => ({
            id: `new-${c.id}`,
            label: c.label,
            icon: c.icon,
            onSelect: make(c),
          })),
        ],
      },
      {
        id: 'collapse',
        label: 'Collapse All',
        icon: ChevronsDownUp,
        onSelect: () => handlers.current.onCollapseAll(),
      },
      {
        id: 'tasks',
        label: tasksShown ? 'Hide task files' : 'Show task files',
        icon: ListTodo,
        pressed: tasksShown,
        onSelect: () => handlers.current.onToggleTasks(),
      },
      {
        id: 'hidden',
        label: hiddenShown ? 'Hide hidden files' : 'Show hidden files',
        icon: hiddenShown ? Eye : EyeOff,
        pressed: hiddenShown,
        onSelect: () => handlers.current.onToggleHidden(),
      },
    ]
  }, [tasksShown, hiddenShown, creates])

  return (
    <div className="motion-respond pointer-events-none absolute top-1 right-3 left-3 z-10 opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/explorer:pointer-events-auto group-hover/explorer:opacity-100 has-[nav:not([data-view=collapsed])]:pointer-events-auto has-[nav:not([data-view=collapsed])]:opacity-100">
      <MorphingMenu label="Explorer" anchor="top-right" surface items={items} />
    </div>
  )
}
