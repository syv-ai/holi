import { useAtomValue } from 'jotai'

import { Kbd, KbdGroup } from '@/components/ui/kbd'
import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { APPS_KEY, BOARD_KEY } from '@/state/tab-descriptor'
import { hotkeyLabels } from '@/lib/hotkey'
import { isMac } from '@/lib/platform'
import { useTabDrag } from '@/features/shell/use-tab-drag'
import { surfacesAtom } from '@/state/plugins'
import { openTaskCountAtom } from '@/state/tasks'
import { AppWindowIcon, SearchIcon, SquareKanbanIcon } from 'lucide-react'

/** Whether vault apps are on: the Apps row is there only while they are. */
export function useAppsOn(): boolean {
  return useAtomValue(surfacesAtom).has('app')
}

/** Search, Board and Apps, at the top of the Documents tab. */
export function DocumentsNav({
  activeId,
  onOpenSearch,
  onOpen,
}: {
  activeId: string | null
  onOpenSearch: () => void
  onOpen: (id: string) => void
}) {
  const openTasks = useAtomValue(openTaskCountAtom)
  // The Board row drags as its tab, onto the content or the strip.
  const tabDrag = useTabDrag()
  const appsOn = useAppsOn()

  return (
    <div className="px-2">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={onOpenSearch} variant="fill">
            <SearchIcon aria-hidden="true" />
            <span>Search</span>
            <KbdGroup className="ms-auto">
              {hotkeyLabels('⌘K', isMac()).map((label) => (
                <Kbd key={label}>{label}</Kbd>
              ))}
            </KbdGroup>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={activeId === BOARD_KEY}
            aria-current={activeId === BOARD_KEY ? 'page' : undefined}
            onClick={() => onOpen(BOARD_KEY)}
            {...tabDrag({ kind: 'board' })}
            variant="fill"
          >
            <SquareKanbanIcon aria-hidden="true" />
            <span>Board</span>
            {openTasks > 0 ? <span className="sr-only">, {openTasks} open tasks</span> : null}
          </SidebarMenuButton>
          {/* A sibling of the button, where the badge's own placement applies. */}
          {openTasks > 0 ? (
            <SidebarMenuBadge key={openTasks} aria-hidden="true">
              {openTasks}
            </SidebarMenuBadge>
          ) : null}
        </SidebarMenuItem>
        {appsOn ? (
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={activeId === APPS_KEY}
              aria-current={activeId === APPS_KEY ? 'page' : undefined}
              onClick={() => onOpen(APPS_KEY)}
              variant="fill"
            >
              <AppWindowIcon aria-hidden="true" />
              <span>Apps</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
    </div>
  )
}
