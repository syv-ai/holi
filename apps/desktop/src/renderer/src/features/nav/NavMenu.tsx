/**
 * The morphing menu at the foot of the nav, and down the rail while the nav is
 * hidden: the registry's rail items (Home, Apps, the board, the agents, mail
 * and the agenda once Google is connected, Settings), around core's own Search
 * and the vault's sync state (`SyncItem`), all sorted
 * by `order` (docs/features/nav-menu.md). A surface with instances (vault
 * apps) is a group that drills down to them.
 *
 * Reads shared state only, never another feature's components: the rail and
 * its instances from `railAtom`, the board's count from `openTaskCountAtom`.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Search } from 'lucide-react'
import { useMemo } from 'react'
import { surfaceLabel } from '@/lib/folder-documents'
import { MorphingMenu, type MorphingMenuItem } from '@/primitives'
import { openPaletteAtom } from '@/state/palette'
import { activeTab, workspaceAtom, type Tab } from '@/state/panes'
import { railAtom } from '@/state/plugins'
import { openSurfaceAtom } from '@/state/surfaces'
import { runCommandAtom } from '@/state/commands'
import { openTaskCountAtom, overdueTaskCountAtom } from '@/state/tasks'
import { useSyncItem } from './SyncItem'

/** An instance's child id: its surface and id, kept apart from the fixed ids. */
const instanceItemId = (surface: string, id: string): string => `${surface}:${id}`

/** Where core's own items sit among the rail's (`RailItem.order`). */
const ORDER = { search: 10, sync: 70 } as const

/** The item the active tab is, if it is one of the menu's destinations. `rail`
 *  says, per surface on the menu, whether it is a group of instances. */
function activeItemId(tab: Tab | null, rail: ReadonlyMap<string, boolean>): string | null {
  if (tab === null || tab.kind !== 'surface' || !rail.has(tab.surface)) return null
  // Any tab of a surface that is one item (each agent terminal) is that item.
  if (tab.id === undefined || rail.get(tab.surface) !== true) return tab.surface
  return instanceItemId(tab.surface, tab.id)
}

export function NavMenu({
  orientation = 'horizontal',
}: {
  orientation?: 'horizontal' | 'vertical'
}): React.JSX.Element {
  const workspace = useAtomValue(workspaceAtom)
  const openSurface = useSetAtom(openSurfaceAtom)
  const openPalette = useSetAtom(openPaletteAtom)
  const runCommand = useSetAtom(runCommandAtom)
  const rail = useAtomValue(railAtom)
  const openTaskCount = useAtomValue(openTaskCountAtom)
  const overdueCount = useAtomValue(overdueTaskCountAtom)
  const sync = useSyncItem()

  // Stable across renders that change nothing here: the menu re-measures and
  // restarts its morph when its items change.
  const items = useMemo((): MorphingMenuItem[] => {
    const placed: { order: number; item: MorphingMenuItem }[] = [
      ...rail.map(({ surface, order, of, label, instances, command, running }) => ({
        order,
        item: {
          id: surface,
          label: `${label ?? surfaceLabel(of)}${running ? ': running' : ''}`,
          icon: of.icon,
          ...(running ? { tone: 'live' as const } : {}),
          // The board's count stays core's until rail items carry badges.
          ...(surface === 'board'
            ? { badge: openTaskCount, badgeTone: overdueCount > 0 ? ('alert' as const) : undefined }
            : {}),
          // Instances, most recently used first, drill down; the rest open.
          ...(command !== undefined
            ? { onSelect: () => void runCommand(command) }
            : instances === undefined
              ? { onSelect: () => openSurface(surface) }
              : {
                  children: instances.map((id) => ({
                    id: instanceItemId(surface, id),
                    label: surfaceLabel(of, id),
                    icon: of.icon,
                    onSelect: () => openSurface(surface, id),
                  })),
                }),
        },
      })),
      {
        order: ORDER.search,
        item: { id: 'search', label: 'Search', icon: Search, onSelect: () => openPalette('open') },
      },
      { order: ORDER.sync, item: sync },
    ]
    // Stable, so items of one order keep the order they were listed in.
    return placed.sort((a, b) => a.order - b.order).map((p) => p.item)
  }, [rail, openTaskCount, overdueCount, sync, openPalette, openSurface, runCommand])

  const railKinds = useMemo(
    () => new Map(rail.map((r) => [r.surface, r.instances !== undefined])),
    [rail],
  )

  return (
    <MorphingMenu
      items={items}
      activeId={activeItemId(activeTab(workspace), railKinds)}
      orientation={orientation}
      label="Go to"
    />
  )
}
