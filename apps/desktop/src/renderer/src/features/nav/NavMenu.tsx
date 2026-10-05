/**
 * The morphing menu at the foot of the nav, and down the rail while the nav is
 * hidden: the registry's rail items (Home, Apps, the board, the agents, mail
 * and the agenda once Google is connected, Settings), around core's own Search
 * and the vault's sync state (`SyncItem`), all sorted
 * by `order` (docs/features/nav-menu.md). A surface with instances (vault
 * apps) is a group that drills down to them. As the window's dock (`dock`) it
 * is the same menu, centred and floating. Where the layout puts the open tabs
 * in the menu, each item holds its surface's in a card over its shortcut, and
 * Open files holds the rest (`OpenTabs`).
 *
 * Reads shared state only, never another feature's components: the rail and
 * its instances from `railAtom`, the board's count from `openTaskCountAtom`.
 */
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { Files, Search } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { surfaceLabel } from '@/lib/folder-documents'
import { MorphingMenu, type MorphingMenuItem } from '@/primitives'
import { openPaletteAtom } from '@/state/palette'
import { activeTab, focusTabAtom, placedTabs, workspaceAtom, type Tab } from '@/state/panes'
import { railAtom, tabsPlacementAtom } from '@/state/plugins'
import { openSurfaceAtom } from '@/state/surfaces'
import { runCommandAtom } from '@/state/commands'
import { openTaskCountAtom, overdueTaskCountAtom } from '@/state/tasks'
import { FILES, OpenTabs, groupTabs, tabGroup, type TabOwners } from './OpenTabs'
import { useSyncItem } from './SyncItem'
import { useTabThumbnails } from '@/state/tab-thumbs'

/** An instance's child id: its surface and id, kept apart from the fixed ids. */
const instanceItemId = (surface: string, id: string): string => `${surface}:${id}`

/** Where core's own items sit among the rail's (`RailItem.order`). */
const ORDER = { search: 10, files: 15, sync: 70 } as const

/** The item the active tab is, if it is one of the menu's destinations. `rail`
 *  says, per surface on the menu, whether it is a group of instances. */
function activeItemId(
  tab: Tab | null,
  rail: ReadonlyMap<string, boolean>,
  owners: TabOwners,
  files: boolean,
): string | null {
  if (tab === null) return null
  const item = tab.kind === 'surface' ? owners.get(tab.surface) : undefined
  // With the tabs in the menu, a tab no item holds is Open files'.
  if (tab.kind !== 'surface' || item === undefined) return files ? FILES : null
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
  const focusTab = useSetAtom(focusTabAtom)
  const tabsInMenu = useAtomValue(tabsPlacementAtom) === 'hub'
  // The previews the cards of open tabs show, taken while each tab is on screen.
  useTabThumbnails(tabsInMenu)

  /** Which item holds each surface's tabs: its own surface, and the one it
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
  // Which groups have tabs open, and how many files, as one string: the items
  // change identity only when that does, not on every move between tabs.
  const placed = tabsInMenu ? placedTabs(workspace) : []
  const openGroups = [...new Set(placed.map((p) => tabGroup(p.tab, owners)))]
    .filter((group) => groupTabs(placed, group, owners).length > 0)
    .sort()
    .join(' ')
  const openFiles = groupTabs(placed, FILES, owners).length

  /** To the file its pane is showing, the focused pane's first; else the last
   *  one opened. Reads the workspace when pressed, so it is stable. */
  const store = useStore()
  const goToFiles = useCallback(() => {
    const w = store.get(workspaceAtom)
    const files = groupTabs(placedTabs(w), FILES, owners)
    const target =
      files.find((f) => f.showing && f.pane === w.active) ??
      files.find((f) => f.showing) ??
      files.at(-1)
    if (target !== undefined) focusTab(target.tab)
  }, [store, owners, focusTab])

  // Stable across renders that change nothing here: the menu re-measures and
  // restarts its morph when its items change.
  const items = useMemo((): MorphingMenuItem[] => {
    const open = new Set(openGroups === '' ? [] : openGroups.split(' '))
    // The card's "+" opens the group's own page: an item's surface, or Home
    // for the files, which have no page of their own.
    const card = (
      group: string,
      title: string,
      onNew: () => void,
    ): Pick<MorphingMenuItem, 'hoverCard'> =>
      open.has(group)
        ? {
            hoverCard: (
              <OpenTabs
                group={group}
                title={title}
                owners={owners}
                onNew={onNew}
                newLabel={group === FILES ? 'Open a file' : `New ${title} tab`}
              />
            ),
          }
        : {}
    const placed: { order: number; item: MorphingMenuItem }[] = [
      ...rail.map(({ surface, order, of, label, instances, command, running }) => ({
        order,
        item: {
          id: surface,
          label: `${label ?? surfaceLabel(of)}${running ? ': running' : ''}`,
          icon: of.icon,
          ...card(surface, label ?? surfaceLabel(of), () => openSurface(surface)),
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
      // The files that are open, while any are: back to the one last shown.
      ...(open.has(FILES)
        ? [
            {
              order: ORDER.files,
              item: {
                id: FILES,
                label: 'Open files',
                icon: Files,
                badge: openFiles,
                onSelect: goToFiles,
                ...card(FILES, 'Open files', () => openSurface('home')),
              },
            },
          ]
        : []),
    ]
    // Stable, so items of one order keep the order they were listed in.
    return placed.sort((a, b) => a.order - b.order).map((p) => p.item)
  }, [
    rail,
    openTaskCount,
    overdueCount,
    sync,
    openPalette,
    openSurface,
    runCommand,
    owners,
    openGroups,
    openFiles,
    goToFiles,
  ])

  const railKinds = useMemo(
    () => new Map(rail.map((r) => [r.surface, r.instances !== undefined])),
    [rail],
  )

  return (
    <MorphingMenu
      items={items}
      activeId={activeItemId(activeTab(workspace), railKinds, owners, tabsInMenu)}
      orientation={orientation}
      {...(dock ? { anchor: 'bottom-center' as const, surface: 'float' as const } : {})}
      label="Go to"
    />
  )
}
