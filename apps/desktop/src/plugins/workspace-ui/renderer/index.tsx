/**
 * Workspace's renderer side (docs/features/nav-menu.md): a second look for the
 * frame, in one plugin. The nav menu leaves the sidebar and sits centred at
 * the foot of the window as a dock, holding the open tabs in place of each
 * pane's strip; the nav's Apps item opens a page of the vault's apps (every
 * open app a tab of the `app` surface, listed on its card); and the Agenda
 * opens on a month to look at and create in.
 *
 * It names the surfaces of the apps and Google plugins and draws over them, so
 * it reads their code (the one other plugin pair, beside the agent's, that may).
 * Each part does nothing while the plugin it draws over is off.
 */
import { AppWindow, CalendarDays } from 'lucide-react'
import type { RailItem, RendererPlugin, Surface } from '@/plugin-api'
import { AgendaView } from '../../google/renderer/AgendaView'
import { WORKSPACE_INFO } from '../info'
import { AppsPage } from './AppsPage'

/** The page of all the vault's apps, where the nav's Apps item goes. */
export const APPS_SURFACE: Surface = {
  kind: 'apps',
  label: 'Apps',
  icon: AppWindow,
  render: AppsPage,
}

/** Apps holds the open apps, tabs of the `app` surface, in its card of open
 *  tabs, and stands in for the apps plugin's own item. */
export const APPS_RAIL: RailItem = { surface: 'apps', order: 20, tabs: 'app', replaces: 'app' }

/** Google's Agenda, opened on the month. Named first among the plugins, so it
 *  is the one the registry keeps for the kind. */
const AGENDA_SURFACE: Surface = {
  kind: 'agenda',
  label: 'Agenda',
  icon: CalendarDays,
  render: (props) => <AgendaView {...props} initialView="month" />,
  homeable: true,
}

export const workspaceRenderer: RendererPlugin = {
  info: WORKSPACE_INFO,
  layout: { hub: 'dock', tabs: 'hub' },
  surfaces: [APPS_SURFACE, AGENDA_SURFACE],
  rail: [APPS_RAIL],
}
