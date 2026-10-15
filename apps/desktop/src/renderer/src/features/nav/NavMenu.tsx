/**
 * The morphing menu at the foot of the nav, and down the rail while the nav is
 * hidden: the registry's rail items (Home, Apps, the board, the agents, mail
 * and the agenda once Google is connected, Settings), around core's own Search
 * and the vault's sync state (`SyncItem`), all sorted
 * by `order` (docs/features/nav-menu.md). A surface with instances (vault
 * apps) is a group that drills down to them. As the window's dock (`dock`) it
 * is the same menu, centred and floating. Where the layout puts the open tabs
 * in the menu, they are its second section, in the same bar after a line
 * (`OpenTabs`). Where it puts Settings and sync in the sidebar's header
 * (`Utilities`), the menu leaves them out.
 *
 * Reads shared state only, never another feature's components: the rail and
 * its instances from `railAtom`, the board's count from `openTaskCountAtom`.
 */
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { Search } from 'lucide-react'
import { useMemo } from 'react'
import { cn } from '@/lib/cn'
import { surfaceLabel } from '@/lib/folder-documents'
import { MorphingMenu, type MorphingMenuItem } from '@/primitives'
import { openPaletteAtom } from '@/state/palette'
import { activeTab, placedTabs, workspaceAtom, type Tab } from '@/state/panes'
import { railAtom, tabsPlacementAtom, utilitiesPlacementAtom } from '@/state/plugins'
import { openSurfaceAtom } from '@/state/surfaces'
import { runCommandAtom } from '@/state/commands'
import { openTaskCountAtom, overdueTaskCountAtom } from '@/state/tasks'
import { OpenTabs, listedTabs, openTabsWidth } from './OpenTabs'
import { useSyncItem } from './SyncItem'

/** An instance's child id: its surface and id, kept apart from the fixed ids. */
const instanceItemId = (surface: string, id: string): string => `${surface}:${id}`

/** Where core's own items sit among the rail's (`RailItem.order`). */
const ORDER = { search: 10, sync: 70 } as const

/** Which nav item a surface's tabs belong to, by surface: its own, and the
 *  one that names it (`RailItem.tabs`). */
type TabOwners = ReadonlyMap<string, string>

/** The item the active tab is, if it is one of the menu's destinations. `rail`
 *  says, per surface on the menu, whether it is a group of instances. */
function activeItemId(
  tab: Tab | null,
  rail: ReadonlyMap<string, boolean>,
  owners: TabOwners,
): string | null {
  if (tab === null) return null
  const item = tab.kind === 'surface' ? owners.get(tab.surface) : undefined
  if (tab.kind !== 'surface' || item === undefined) return null
  // Any tab of a surface that is one item (each agent terminal) is that item.
  if (tab.id === undefined || rail.get(item) !== true) return item
  return instanceItemId(item, tab.id)
}

export function NavMenu({
  orientation = 'horizontal',
  dock = false,
}: {
  orientation?: 'horizontal' | 'vertical'
  /** Centred at the foot of its box on a surface of its own, opening upward
   *  from the middle. */
  dock?: boolean
}): React.JSX.Element {
  const workspace = useAtomValue(workspaceAtom)
  const openSurface = useSetAtom(openSurfaceAtom)
  const openPalette = useSetAtom(openPaletteAtom)
  const runCommand = useSetAtom(runCommandAtom)
  const rail = useAtomValue(railAtom)
  const openTaskCount = useAtomValue(openTaskCountAtom)
  const overdueCount = useAtomValue(overdueTaskCountAtom)
  const sync = useSyncItem()
  const tabsInMenu = useAtomValue(tabsPlacementAtom) === 'hub'
  // Settings and sync are in the sidebar's header then, not here.
  const utilitiesElsewhere = useAtomValue(utilitiesPlacementAtom) === 'header'
  const showSync = !utilitiesElsewhere

  /** Which item each surface's tabs belong to: its own surface, and the one it
   *  names (`RailItem.tabs`). */
  const owners = useMemo<TabOwners>(
    () =>
      new Map(
        rail.flatMap((r): [string, string][] => [
          [r.surface, r.surface],
          ...(r.tabs === undefined ? [] : [[r.tabs, r.surface] as [string, string]]),
        ]),
      ),
    [rail],
  )

  const shown = useMemo(
    () => (utilitiesElsewhere ? rail.filter((r) => r.surface !== 'settings') : rail),
    [rail, utilitiesElsewhere],
  )

  // Stable across renders that change nothing here: the menu re-measures and
  // restarts its morph when its items change.
  const items = useMemo((): MorphingMenuItem[] => {
    const placed: { order: number; item: MorphingMenuItem }[] = [
      ...shown.map(({ surface, order, of, label, instances, command, running }) => ({
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
      ...(showSync ? [{ order: ORDER.sync, item: sync }] : []),
    ]
    // Stable, so items of one order keep the order they were listed in.
    return placed.sort((a, b) => a.order - b.order).map((p) => p.item)
  }, [shown, openTaskCount, overdueCount, sync, showSync, openPalette, openSurface, runCommand])

  const railKinds = useMemo(
    () => new Map(rail.map((r) => [r.surface, r.instances !== undefined])),
    [rail],
  )

  /** The surfaces an item is the way to, which the open tabs leave out. */
  const onMenu = useMemo(() => new Set(shown.map((r) => r.surface)), [shown])

  const tabs = <OpenTabs onMenu={onMenu} wrap={!dock} />
  const listed = tabsInMenu ? listedTabs(placedTabs(workspace), onMenu) : []

  const menu = (
    <MorphingMenu
      items={items}
      activeId={activeItemId(activeTab(workspace), railKinds, owners)}
      orientation={orientation}
      {...(dock ? { anchor: 'bottom-center' as const, surface: 'float' as const } : {})}
      // As the dock, the open tabs are the bar's second section.
      {...(dock && listed.length > 0
        ? {
            trailing: { content: tabs, width: openTabsWidth(listed.length) },
          }
        : {})}
      label="Go to"
    />
  )
  if (!tabsInMenu || dock) return menu
  // In the sidebar and down the rail the tabs wrap above the menu.
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-1',
        orientation === 'vertical' ? 'min-h-0 flex-1 justify-end' : 'w-full',
      )}
    >
      {tabs}
      {menu}
    </div>
  )
}
