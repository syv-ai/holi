/**
 * The morphing menu at the foot of the nav, and down the rail while the nav is
 * hidden (D108): Home, Search, Apps, Board, Email and Agenda once Google is
 * connected, then Settings beside More.
 *
 * Reads shared state only, never another feature's components: the apps from
 * `appPathsAtom`, the count from `openTaskCountAtom`, Google from the account
 * atom Shell's `useGoogleAccount` fills. `undefined` there means "not asked
 * yet", and hides Email and Agenda too, so they never flash in.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { CalendarDays, House, Mail, Search, Settings, SquareKanban } from 'lucide-react'
import { useMemo } from 'react'
import { appName } from '@holi/shared'
import { MorphingMenu, type MorphingMenuItem } from '@/primitives'
import { AppIcon } from '@/composites/file-icons'
import { appPathsAtom } from '@/state/apps'
import { googleAccountAtom } from '@/state/google'
import { openPaletteAtom } from '@/state/palette'
import {
  activeTab,
  openAgenda,
  openApp,
  openBoard,
  openHome,
  openMail,
  openSettings,
  workspaceAtom,
  type Tab,
} from '@/state/panes'
import { openTaskCountAtom, overdueTaskCountAtom } from '@/state/tasks'

/** An app's child id: its bundle path, kept apart from the fixed ids. */
const appItemId = (path: string): string => `app:${path}`

/** The item the active tab is, if it is one of the menu's destinations. */
function activeItemId(tab: Tab | null): string | null {
  if (tab === null) return null
  if (tab.kind === 'app') return appItemId(tab.path)
  if (
    tab.kind === 'home' ||
    tab.kind === 'board' ||
    tab.kind === 'settings' ||
    tab.kind === 'mail' ||
    tab.kind === 'agenda'
  ) {
    return tab.kind
  }
  return null
}

export function NavMenu({
  orientation = 'horizontal',
}: {
  orientation?: 'horizontal' | 'vertical'
}): React.JSX.Element {
  const workspace = useAtomValue(workspaceAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  const openPalette = useSetAtom(openPaletteAtom)
  const appPaths = useAtomValue(appPathsAtom)
  const openTaskCount = useAtomValue(openTaskCountAtom)
  const overdueCount = useAtomValue(overdueTaskCountAtom)
  const googleConnected = useAtomValue(googleAccountAtom) != null

  // Stable across renders that change nothing here: the menu re-measures and
  // restarts its morph when its items change.
  const items = useMemo((): MorphingMenuItem[] => {
    const icon = (Glyph: typeof House) => <Glyph size={16} />
    return [
      { id: 'home', label: 'Home', icon: icon(House), onSelect: () => setWorkspace(openHome) },
      { id: 'search', label: 'Search', icon: icon(Search), onSelect: () => openPalette('open') },
      ...(appPaths.length > 0
        ? [
            {
              id: 'apps',
              label: 'Apps',
              icon: <AppIcon size={16} />,
              children: appPaths.map((path) => ({
                id: appItemId(path),
                label: appName(path),
                icon: <AppIcon size={16} />,
                onSelect: () => setWorkspace((w) => openApp(w, path)),
              })),
            },
          ]
        : []),
      {
        id: 'board',
        label: 'Board',
        icon: icon(SquareKanban),
        badge: openTaskCount,
        badgeTone: overdueCount > 0 ? 'alert' : undefined,
        onSelect: () => setWorkspace(openBoard),
      },
      ...(googleConnected
        ? [
            {
              id: 'mail',
              label: 'Email',
              icon: icon(Mail),
              onSelect: () => setWorkspace(openMail),
            },
            {
              id: 'agenda',
              label: 'Agenda',
              icon: icon(CalendarDays),
              onSelect: () => setWorkspace(openAgenda),
            },
          ]
        : []),
      // Last, so it sits beside More at the dock's end.
      {
        id: 'settings',
        label: 'Settings',
        icon: icon(Settings),
        onSelect: () => setWorkspace(openSettings),
      },
    ]
  }, [appPaths, openTaskCount, overdueCount, googleConnected, setWorkspace, openPalette])

  return (
    <MorphingMenu
      items={items}
      activeId={activeItemId(activeTab(workspace))}
      orientation={orientation}
      label="Go to"
    />
  )
}
