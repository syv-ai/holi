/**
 * The morphing menu at the foot of the nav, and down the rail while the nav is
 * hidden: the registry's rail items (Home, the board, mail and the agenda once
 * Google is connected, Settings), around core's own Search, Apps, the vault's
 * assistant (`AgentItem`) and the vault's sync state (`SyncItem`), all sorted
 * by `order` (docs/features/nav-menu.md).
 *
 * Reads shared state only, never another feature's components: the rail from
 * `railAtom`, the apps from `appPathsByRecencyAtom`, the board's count from
 * `openTaskCountAtom`.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Search } from 'lucide-react'
import { useMemo } from 'react'
import { appName } from '@holi/shared'
import { MorphingMenu, type MorphingMenuItem } from '@/primitives'
import { AppIcon } from '@/composites/file-icons'
import { openPaletteAtom } from '@/state/palette'
import { activeTab, openApp, workspaceAtom, type Tab } from '@/state/panes'
import { railAtom } from '@/state/plugins'
import { appPathsByRecencyAtom } from '@/state/recents'
import { openSurfaceAtom } from '@/state/surfaces'
import { openTaskCountAtom, overdueTaskCountAtom } from '@/state/tasks'
import { useAgentItem } from './AgentItem'
import { useSyncItem } from './SyncItem'

/** An app's child id: its bundle path, kept apart from the fixed ids. */
const appItemId = (path: string): string => `app:${path}`

/** Where core's own items sit among the rail's (`RailItem.order`). */
const ORDER = { search: 10, apps: 20, agent: 60, sync: 70 } as const

/** The item the active tab is, if it is one of the menu's destinations. */
function activeItemId(tab: Tab | null, rail: ReadonlySet<string>): string | null {
  if (tab === null) return null
  if (tab.kind === 'app') return appItemId(tab.path)
  if (tab.kind === 'agent') return 'agent'
  if (tab.kind === 'surface' && rail.has(tab.surface)) return tab.surface
  return null
}

export function NavMenu({
  orientation = 'horizontal',
}: {
  orientation?: 'horizontal' | 'vertical'
}): React.JSX.Element {
  const workspace = useAtomValue(workspaceAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  const openSurface = useSetAtom(openSurfaceAtom)
  const openPalette = useSetAtom(openPaletteAtom)
  const rail = useAtomValue(railAtom)
  // Most recently opened first; the same array until the order changes.
  const appOrder = useAtomValue(appPathsByRecencyAtom)
  const openTaskCount = useAtomValue(openTaskCountAtom)
  const overdueCount = useAtomValue(overdueTaskCountAtom)
  const sync = useSyncItem()
  const agent = useAgentItem()

  // Stable across renders that change nothing here: the menu re-measures and
  // restarts its morph when its items change.
  const items = useMemo((): MorphingMenuItem[] => {
    const placed: { order: number; item: MorphingMenuItem }[] = [
      ...rail.map(({ surface, order, of }) => ({
        order,
        item: {
          id: surface,
          label: of.label,
          icon: of.icon,
          // The board's count stays core's until rail items carry badges.
          ...(surface === 'board'
            ? { badge: openTaskCount, badgeTone: overdueCount > 0 ? ('alert' as const) : undefined }
            : {}),
          onSelect: () => openSurface(surface),
        },
      })),
      {
        order: ORDER.search,
        item: { id: 'search', label: 'Search', icon: Search, onSelect: () => openPalette('open') },
      },
      ...(appOrder.length > 0
        ? [
            {
              order: ORDER.apps,
              item: {
                id: 'apps',
                label: 'Apps',
                icon: AppIcon,
                children: appOrder.map((path) => ({
                  id: appItemId(path),
                  label: appName(path),
                  icon: AppIcon,
                  onSelect: () => setWorkspace((w) => openApp(w, path)),
                })),
              },
            },
          ]
        : []),
      { order: ORDER.agent, item: agent },
      { order: ORDER.sync, item: sync },
    ]
    // Stable, so items of one order keep the order they were listed in.
    return placed.sort((a, b) => a.order - b.order).map((p) => p.item)
  }, [
    rail,
    appOrder,
    openTaskCount,
    overdueCount,
    agent,
    sync,
    setWorkspace,
    openPalette,
    openSurface,
  ])

  const railKinds = useMemo(() => new Set(rail.map((r) => r.surface)), [rail])

  return (
    <MorphingMenu
      items={items}
      activeId={activeItemId(activeTab(workspace), railKinds)}
      orientation={orientation}
      label="Go to"
    />
  )
}
