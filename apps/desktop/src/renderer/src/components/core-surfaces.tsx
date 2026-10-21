/**
 * Core's own surfaces, nav items and claims (docs/features/tabs-panes.md),
 * installed into the registry by `main.tsx` beside the plugins' list.
 *
 * The board, quick add, the task-file claim and the marks it puts on the
 * tree are still core's until the tasks plugin takes them.
 */
import { useAtomValue } from 'jotai'
import { History, House, Settings, SquareKanban, Waypoints } from 'lucide-react'
import type { RailItem, Surface } from '@/plugin-api/types'
import { GraphView } from '@/features/graph/GraphView'
import { HistoryView } from '@/features/history/HistoryView'
import { HomeView } from '@/features/home/HomeView'
import { SettingsView } from '@/features/settings/SettingsView'
import { BoardView } from '@/features/tasks/BoardView'
import { QuickAddHost } from '@/features/tasks/QuickAddHost'
import { TASK_PATH_CLAIM, taskMarksAtom } from '@/features/tasks/task-claim'
import { homeDocumentAtom, homeTargetAtom } from '@/state/home'
import { surfacesAtom, type CoreContribution } from '@/state/plugins'
import { boardBadgeAtom } from '@/state/tasks'

/**
 * The Home tab: the folder document Home names (a vault app), in its own surface,
 * when the vault has it; otherwise HomeView shows the recents, or says why
 * Home is not there (`state/home.ts`).
 */
function HomeSurface(): React.JSX.Element {
  const home = useAtomValue(homeTargetAtom)
  const doc = useAtomValue(homeDocumentAtom)
  const View = useAtomValue(surfacesAtom).get(doc?.surface ?? '')?.render
  return doc !== null && View !== undefined ? (
    <View id={doc.id} visible />
  ) : (
    <HomeView target={home} />
  )
}

const SURFACES: readonly Surface[] = [
  { kind: 'home', label: 'Home', icon: House, render: HomeSurface },
  { kind: 'board', label: 'Board', icon: SquareKanban, render: BoardView, homeable: true },
  { kind: 'settings', label: 'Settings', icon: Settings, render: SettingsView },
  { kind: 'history', label: 'History', icon: History, render: HistoryView },
  { kind: 'graph', label: 'Graph', icon: Waypoints, render: GraphView },
]

const RAIL: readonly RailItem[] = [
  { surface: 'home', order: 0 },
  { surface: 'board', order: 30, badge: boardBadgeAtom },
  { surface: 'graph', order: 35 },
  // Last, so it ends the dock.
  { surface: 'settings', order: 100 },
]

export const CORE_CONTRIBUTION: CoreContribution = {
  surfaces: SURFACES,
  rail: RAIL,
  claims: [TASK_PATH_CLAIM],
  overlays: [QuickAddHost],
  pathMarks: taskMarksAtom,
}
