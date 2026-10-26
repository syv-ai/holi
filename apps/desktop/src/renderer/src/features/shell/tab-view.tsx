import { useAtomValue } from 'jotai'
import { AppWindowIcon, AstroidIcon, FileTextIcon, SearchIcon } from 'lucide-react'

import { IconStackEmpty } from '@/components/reui/icon-stack-empty'
import { SettingsView } from '@/features/settings/settings-view'
import { runningPluginsAtom, surfacesAtom } from '@/state/plugins'
import { parseTabKey } from '@/state/tab-descriptor'
import { snapshotAtom } from '@/state/vaults'

import { AppsView } from '@/features/apps/apps-view'
import { VaultAppTab } from '@/features/apps/vault-app-tab'
import { DocumentView } from '@/features/documents/document-view'
import { FileView } from '@/features/files/file-view'
import { GraphView } from '@/features/graph/graph-view'
import { PlanningView } from '@/features/planning/planning-view'
import { NewTabView } from './new-tab-view'
import { useSidebarApps } from '@/features/sidebar/sidebar-apps'

/**
 * What one tab shows (docs/features/tabs-panes.md): the view switch the shell
 * used to make for its one main area, now made once per pane for the pane's
 * active tab. A null tab is an empty pane, which shows the New tab's view.
 */
export function TabView({
  tab,
  settingsNavInSidebar,
  onOpen,
  onOpenBeside,
  reading = null,
  onMoved,
  onNewDocument,
  onOpenSearch,
}: {
  tab: string | null
  /** Whether the sidebar carries Settings' nav for this tab; otherwise the
   *  view draws its own. */
  settingsNavInSidebar: boolean
  /** Open a vault path or the board, the way the shell opens one. */
  onOpen: (key: string) => void
  /** Open it beside this tab, in a split: where the graph opens a note. */
  onOpenBeside: (key: string) => void
  /** The document open beside this tab in its split, if any. */
  reading?: string | null
  /** A document moved (a task given another project): its tabs follow. */
  onMoved: (from: string, to: string) => void
  onNewDocument: () => void
  onOpenSearch: () => void
}) {
  const running = useAtomValue(runningPluginsAtom)
  const surfaces = useAtomValue(surfacesAtom)
  /** The vault's non-markdown files, which open in the file viewer. */
  const vaultFiles = useAtomValue(snapshotAtom).files
  const apps = useSidebarApps()
  const AgentsMain = running.find((plugin) => plugin.agentsMode)?.agentsMode?.main
  const descriptor = tab === null ? null : parseTabKey(tab)

  switch (descriptor?.kind) {
    case undefined:
    case 'new':
      return <NewTabView key={tab ?? 'none'} onOpen={onOpen} onNewDocument={onNewDocument} />
    case 'board':
      return <PlanningView onOpenTask={onOpen} />
    case 'graph':
      return <GraphView onOpen={onOpenBeside} reading={reading} />
    case 'apps':
      return <AppsView onOpen={onOpen} />
    case 'surface': {
      // A tab onto another registered surface: the trust terminal after
      // onboarding, as the agent's surface on its terminal.
      const Surface = surfaces.get(descriptor.surface)?.render
      if (Surface !== undefined) {
        return <Surface key={tab} id={descriptor.id ?? ''} visible />
      }
      return (
        <IconStackEmpty
          icon={AppWindowIcon}
          title="This view is not running"
          description="Turn its plugin on to open it here."
          action={{ label: 'Search', icon: SearchIcon, onClick: onOpenSearch }}
        />
      )
    }
    case 'settings':
      return <SettingsView navHidden={!settingsNavInSidebar} />
    case 'app': {
      const AppView = apps.find((app) => app.id === descriptor.id)?.render
      if (AppView === undefined) {
        return (
          <IconStackEmpty
            icon={AppWindowIcon}
            title="This app is not running"
            description="Turn its plugin on, or connect the account it needs, to open it here."
            action={{
              label: 'Search',
              icon: SearchIcon,
              onClick: onOpenSearch,
            }}
          />
        )
      }
      // An app arrives from the rail's edge, where the files just folded
      // away: once per switch, keyed on the tab.
      return (
        <div key={tab} className="motion-in-rise flex min-h-0 flex-1 flex-col">
          <AppView />
        </div>
      )
    }
    case 'agents-home':
    case 'session':
      if (AgentsMain === undefined) {
        return (
          <IconStackEmpty
            icon={AstroidIcon}
            title="Agents are not running"
            description="The agent plugin is off in this vault."
            action={{
              label: 'Search',
              icon: SearchIcon,
              onClick: onOpenSearch,
            }}
          />
        )
      }
      return (
        <AgentsMain
          key={tab}
          selection={
            descriptor.kind === 'session' ? { owner: descriptor.owner, id: descriptor.id } : null
          }
        />
      )
    case 'vault-app':
      // A vault app is the `app` surface, by its bundle's path, under its
      // header (Reload, the log, Edit source).
      return <VaultAppTab key={tab} path={descriptor.path} onOpenSearch={onOpenSearch} />
    case 'doc':
      if (/\.md$/i.test(descriptor.path)) {
        return <DocumentView key={tab} path={descriptor.path} onOpen={onOpen} onMoved={onMoved} />
      }
      // Any other file: css, yaml, json, an image, a PDF.
      if (vaultFiles.some((file) => file.path === descriptor.path)) {
        return <FileView key={tab} path={descriptor.path} />
      }
      return (
        <IconStackEmpty
          key={tab}
          icon={FileTextIcon}
          title={descriptor.path}
          description="This file is no longer in the vault."
          action={{ label: 'Search', icon: SearchIcon, onClick: onOpenSearch }}
        />
      )
  }
}
