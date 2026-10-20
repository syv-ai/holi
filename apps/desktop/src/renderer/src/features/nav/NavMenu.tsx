/**
 * The nav's items (docs/features/nav-menu.md): the registry's rail items (Home,
 * Apps, the board, the agents, mail and the agenda once Google is connected,
 * Settings), around core's own Search and the vault's sync state
 * (`SyncItem`), with an update to Holi once one is ready (`UpdateItem`), all
 * sorted by `order`. A surface with instances (vault apps) is a group of them.
 *
 * `useNavItems` is what the sidebar reads; `NavMenu` draws the same items as
 * one dropdown menu, for a place with no room for the sidebar's rows.
 *
 * Reads shared state only, never another feature's components: the rail and
 * its instances from `railAtom`, the board's count from `openTaskCountAtom`.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Menu, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '@/lib/cn'
import { surfaceLabel } from '@/lib/folder-documents'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  ICON_MOTION,
  ICON_TONE,
} from '@/primitives'
import { openPaletteAtom } from '@/state/palette'
import { activeTab, workspaceAtom, type Tab } from '@/state/panes'
import { railAtom } from '@/state/plugins'
import { openSurfaceAtom } from '@/state/surfaces'
import { runCommandAtom } from '@/state/commands'
import { openTaskCountAtom, overdueTaskCountAtom } from '@/state/tasks'
import { useSyncItem } from './SyncItem'
import { useUpdateItem } from './UpdateItem'
import type { NavAction, NavItem } from './nav-item'

/** An instance's child id: its surface and id, kept apart from the fixed ids. */
const instanceItemId = (surface: string, id: string): string => `${surface}:${id}`

/** Where core's own items sit among the rail's (`RailItem.order`). Exported
 *  so the sidebar can tell the floor's items from the destinations. */
export const ORDER = { search: 10, sync: 70, update: 75 } as const

/** The item the active tab is, if it is one of the menu's destinations. `rail`
 *  says, per surface on the menu, whether it is a group of instances. */
function activeItemId(tab: Tab | null, rail: ReadonlyMap<string, boolean>): string | null {
  if (tab === null || tab.kind !== 'surface' || !rail.has(tab.surface)) return null
  // Any tab of a surface that is one item (each agent terminal) is that item.
  if (tab.id === undefined || rail.get(tab.surface) !== true) return tab.surface
  return instanceItemId(tab.surface, tab.id)
}

/**
 * Every place the nav offers, as menu items in their order, and the one the
 * active tab is: read by the rail's dock (`NavMenu`) and by the sidebar's
 * labelled rows (`Sidebar.tsx`), so the two can never disagree about where
 * you can go.
 */
export function useNavItems(): { items: NavItem[]; activeId: string | null } {
  const workspace = useAtomValue(workspaceAtom)
  const openSurface = useSetAtom(openSurfaceAtom)
  const openPalette = useSetAtom(openPaletteAtom)
  const runCommand = useSetAtom(runCommandAtom)
  const rail = useAtomValue(railAtom)
  const openTaskCount = useAtomValue(openTaskCountAtom)
  const overdueCount = useAtomValue(overdueTaskCountAtom)
  const sync = useSyncItem()
  const update = useUpdateItem()

  // Stable across renders that change nothing here.
  const items = useMemo((): NavItem[] => {
    const placed: { order: number; item: NavItem }[] = [
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
      ...(update === null ? [] : [{ order: ORDER.update, item: update }]),
    ]
    // Stable, so items of one order keep the order they were listed in.
    return placed.sort((a, b) => a.order - b.order).map((p) => p.item)
  }, [rail, openTaskCount, overdueCount, sync, update, openPalette, openSurface, runCommand])

  const railKinds = useMemo(
    () => new Map(rail.map((r) => [r.surface, r.instances !== undefined])),
    [rail],
  )
  return { items, activeId: activeItemId(activeTab(workspace), railKinds) }
}

/** One item's glyph and label, with its count at the end. */
function ItemLabel({ item, active }: { item: NavAction; active: boolean }): React.JSX.Element {
  return (
    <>
      <Icon
        icon={item.icon}
        size="sm"
        className={cn(item.tone && ICON_TONE[item.tone], item.motion && ICON_MOTION[item.motion])}
      />
      <span className={cn('min-w-0 flex-1 truncate', active && 'font-medium')}>{item.label}</span>
      {item.badge !== undefined && item.badge > 0 && (
        <span
          data-tone={item.badgeTone}
          className={cn(
            'shrink-0 text-xs tabular-nums',
            item.badgeTone === 'alert' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {item.badge}
        </span>
      )}
    </>
  )
}

/** The nav's items as one dropdown: a group or a panel opens as a submenu. */
export function NavMenu(): React.JSX.Element {
  const { items, activeId } = useNavItems()
  const [open, setOpen] = useState(false)
  const isActive = (item: NavItem) =>
    activeId === item.id || Boolean(item.children?.some((child) => child.id === activeId))

  const action = (item: NavAction) => (
    <DropdownMenuItem
      key={item.id}
      aria-current={activeId === item.id ? 'page' : undefined}
      onSelect={() => item.onSelect?.()}
    >
      <ItemLabel item={item} active={activeId === item.id} />
    </DropdownMenuItem>
  )

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <IconButton icon={Menu} label="Go to" size="md" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        {items.map((item) =>
          item.children?.length || item.panel ? (
            <DropdownMenuSub key={item.id}>
              <DropdownMenuSubTrigger aria-current={isActive(item) ? 'true' : undefined}>
                <ItemLabel item={item} active={isActive(item)} />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                aria-label={item.label}
                className={item.panel ? 'w-auto p-0' : undefined}
              >
                {item.panel ? item.panel(() => setOpen(false), true) : item.children!.map(action)}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : (
            action(item)
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
