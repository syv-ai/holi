/**
 * Core's own surfaces and nav items (docs/features/tabs-panes.md), installed
 * into the registry by `main.tsx` beside the plugins' list.
 *
 * The board, the agenda and mail are still core's until their plugins take
 * them; each will move with its feature.
 */
import { useAtomValue } from 'jotai'
import { atom } from 'jotai'
import { CalendarDays, History, House, Mail, Settings, SquareKanban } from 'lucide-react'
import type { RailItem, Surface } from '@/plugin-api/types'
import { AppFrame } from '@/features/apps/AppFrame'
import { AgendaView } from '@/features/google/AgendaView'
import { MailView } from '@/features/google/MailView'
import { HistoryView } from '@/features/history/HistoryView'
import { HomeView } from '@/features/home/HomeView'
import { SettingsView } from '@/features/settings/SettingsView'
import { BoardView } from '@/features/tasks/BoardView'
import { appPathsAtom } from '@/state/apps'
import { googleAccountAtom } from '@/state/google'
import { homeTargetAtom } from '@/state/home'

/**
 * The Home tab: Home's app when it names one the vault has; otherwise
 * HomeView shows the recents, or says why Home is not there
 * (`state/home.ts`).
 */
function HomeSurface(): React.JSX.Element {
  const home = useAtomValue(homeTargetAtom)
  const appPaths = useAtomValue(appPathsAtom)
  return home.kind === 'app' && appPaths.includes(home.path) ? (
    <AppFrame path={home.path} />
  ) : (
    <HomeView target={home} />
  )
}

const SURFACES: readonly Surface[] = [
  { kind: 'home', label: 'Home', icon: House, render: HomeSurface },
  { kind: 'board', label: 'Board', icon: SquareKanban, render: BoardView, homeable: true },
  { kind: 'mail', label: 'Mail', icon: Mail, render: MailView, homeable: true },
  { kind: 'agenda', label: 'Agenda', icon: CalendarDays, render: AgendaView, homeable: true },
  { kind: 'settings', label: 'Settings', icon: Settings, render: SettingsView },
  { kind: 'history', label: 'History', icon: History, render: HistoryView },
]

/** Mail and the agenda show once Google is connected. `undefined` there means
 *  "not asked yet" and hides them too, so they never flash in. */
const googleConnectedAtom = atom((get) => get(googleAccountAtom) != null)

const RAIL: readonly RailItem[] = [
  { surface: 'home', order: 0 },
  { surface: 'board', order: 30 },
  { surface: 'mail', order: 40, visible: googleConnectedAtom },
  { surface: 'agenda', order: 50, visible: googleConnectedAtom },
  // Last, so it ends the dock.
  { surface: 'settings', order: 100 },
]

export const CORE_SURFACES = { surfaces: SURFACES, rail: RAIL }
