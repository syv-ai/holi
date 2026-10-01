/**
 * Core's own surfaces, nav items and claims (docs/features/tabs-panes.md),
 * installed into the registry by `main.tsx` beside the plugins' list.
 *
 * The board is still core's until the tasks plugin takes it.
 */
import { useAtomValue } from 'jotai'
import { History, House, Settings, SquareKanban } from 'lucide-react'
import type { RailItem, Surface } from '@/plugin-api/types'
import { HistoryView } from '@/features/history/HistoryView'
import { HomeView } from '@/features/home/HomeView'
import { SettingsView } from '@/features/settings/SettingsView'
import { BoardView } from '@/features/tasks/BoardView'
import { homeDocumentAtom, homeTargetAtom } from '@/state/home'
import { surfacesAtom, type CoreContribution } from '@/state/plugins'

/**
 * The Home tab: the folder document Home names (a vault app), in its own surface,
 * when the vault has it; otherwise HomeView shows the recents, or says why
 * Home is not there (`state/home.ts`).
 */
function HomeSurface(): React.JSX.Element {
  const home = useAtomValue(homeTargetAtom)
  const doc = useAtomValue(homeDocumentAtom)
  const View = useAtomValue(surfacesAtom).get(doc?.surface ?? '')?.render
  return doc !== null && View !== undefined ? <View id={doc.id} /> : <HomeView target={home} />
}

const SURFACES: readonly Surface[] = [
  { kind: 'home', label: 'Home', icon: House, render: HomeSurface },
  { kind: 'board', label: 'Board', icon: SquareKanban, render: BoardView, homeable: true },
  { kind: 'settings', label: 'Settings', icon: Settings, render: SettingsView },
  { kind: 'history', label: 'History', icon: History, render: HistoryView },
]

const RAIL: readonly RailItem[] = [
  { surface: 'home', order: 0 },
  { surface: 'board', order: 30 },
  // Last, so it ends the dock.
  { surface: 'settings', order: 100 },
]

export const CORE_CONTRIBUTION: CoreContribution = {
  surfaces: SURFACES,
  rail: RAIL,
  claims: [],
}
