import { ChevronsDownUp, Eye, EyeOff, FilePlus, FolderPlus, Plus } from 'lucide-react'
import { useMemo, useRef } from 'react'
import type { ClaimCreate } from '@/plugin-api/types'
import { MorphingMenu, type MorphingMenuItem, type IconGlyph } from '@/primitives'

/** What "+" makes: core's kinds, or what a claim makes (a task, an app).
 *  Where it lands is the tree's to decide. */
export type NewKind = 'file' | 'folder' | ClaimCreate

/** A hideable claim's toggle (`PathClaim.hideable`): its files, named. */
export interface ClaimToggle {
  id: string
  label: string
  icon: IconGlyph
  shown: boolean
}

/**
 * The explorer's toolbar: the nav menu's morphing menu, anchored at the tree's
 * top-right and opening downward. "+" unfolds into what can be made; Collapse
 * All and the filters (hidden files, and each hideable claim's files) are
 * shortcuts, the filters pressed while on. Icons
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
  claimToggles = [],
  onToggleClaimed,
}: {
  /** What enabled claims add to "+", after core's own. */
  creates?: readonly ClaimCreate[]
  onNew: (kind: NewKind) => void
  onCollapseAll: () => void
  /** Whether hidden (dot-prefixed) entries are currently shown. */
  hiddenShown: boolean
  onToggleHidden: () => void
  /** What enabled claims hide until shown, each a filter. */
  claimToggles?: readonly ClaimToggle[]
  onToggleClaimed?: (id: string) => void
}) {
  // The menu restarts its layout pass when its items change identity, so the
  // items depend on the states and what claims make only, and call the
  // latest handlers.
  const handlers = useRef({ onNew, onCollapseAll, onToggleHidden, onToggleClaimed })
  handlers.current = { onNew, onCollapseAll, onToggleHidden, onToggleClaimed }

  const items = useMemo((): MorphingMenuItem[] => {
    const make = (kind: NewKind) => () => handlers.current.onNew(kind)
    return [
      {
        id: 'new',
        label: 'New',
        icon: Plus,
        children: [
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
      ...claimToggles.map((t) => ({
        id: `claimed-${t.id}`,
        label: `${t.shown ? 'Hide' : 'Show'} ${t.label}`,
        icon: t.icon,
        pressed: t.shown,
        onSelect: () => handlers.current.onToggleClaimed?.(t.id),
      })),
      {
        id: 'hidden',
        label: hiddenShown ? 'Hide hidden files' : 'Show hidden files',
        icon: hiddenShown ? Eye : EyeOff,
        pressed: hiddenShown,
        onSelect: () => handlers.current.onToggleHidden(),
      },
    ]
  }, [claimToggles, hiddenShown, creates])

  return (
    <div className="motion-respond pointer-events-none absolute top-1 right-3 left-3 z-10 opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/explorer:pointer-events-auto group-hover/explorer:opacity-100 has-[nav:not([data-view=collapsed])]:pointer-events-auto has-[nav:not([data-view=collapsed])]:opacity-100">
      <MorphingMenu label="Explorer" anchor="top-right" surface items={items} />
    </div>
  )
}
