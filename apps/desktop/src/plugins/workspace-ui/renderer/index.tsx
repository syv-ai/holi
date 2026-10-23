/**
 * Workspace's renderer side (docs/features/nav-menu.md): a second look for the
 * frame, in one plugin. The nav menu leaves the sidebar and sits centred at
 * the foot of the window as a dock, with the open tabs as its second section
 * in place of each pane's strip, and Settings and sync in the sidebar's header;
 * the nav's Apps item opens a page of the vault's apps (every open app a tab
 * of the `app` surface).
 *
 * Its Apps page is about the apps plugin's apps, so it `requires` that plugin:
 * with apps off there is no page and no item, and the dock stays. (The Agenda
 * opening on its month is Google's own `agendaView` setting.)
 */
import { AppWindow } from 'lucide-react'
import type { RailItem, RendererPlugin, Surface } from '@/plugin-api'
import { WORKSPACE_INFO } from '../info'
import { AppsPage } from './AppsPage'

/** The page of all the vault's apps, where the nav's Apps item goes. */
export const APPS_SURFACE: Surface = {
  kind: 'apps',
  label: 'Apps',
  icon: AppWindow,
  render: AppsPage,
  requires: ['apps'],
}

/** Apps reads as current while an app, a tab of the `app` surface, is showing,
 *  and stands in for the apps plugin's own item. */
export const APPS_RAIL: RailItem = { surface: 'apps', order: 20, tabs: 'app', replaces: 'app' }

export const workspaceRenderer: RendererPlugin = {
  info: WORKSPACE_INFO,
  layout: { hub: 'dock', tabs: 'hub', utilities: 'header' },
  surfaces: [APPS_SURFACE],
  rail: [APPS_RAIL],
}
