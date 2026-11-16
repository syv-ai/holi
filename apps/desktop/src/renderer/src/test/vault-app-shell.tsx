/** Test adapter for the real retained-tab renderer. A plugin supplies its
 * surface through the same registry seam as production, never a core import. */
import { Provider, createStore, getDefaultStore, useAtomValue } from 'jotai'
import { emptyVaultSnapshot, type ColorScheme } from '@holi/shared'
import { Button } from '@/components/ui/button'
import { TabView } from '@/features/shell/tab-view'
import { useRetainedSurfaces } from '@/features/shell/retained-surfaces'
import { coreContributionAtom } from '@/state/plugins'
import type { Surface } from '@/state/plugin-types'
import { colorSchemeAtom } from '@/state/color-scheme'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import {
  activeEntry,
  activeSplit,
  closeTab,
  entryViews,
  openInSplit,
  openTab,
  selectEntry,
  separate,
} from '@/state/shell-workspace'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'
import { act, render } from './render'

/** Change the actual theme input, without exposing writable core state to plugins. */
export function setTestColorScheme(scheme: ColorScheme): void {
  getDefaultStore().set(colorSchemeAtom, scheme)
}

function RetainedTabs() {
  const workspace = useAtomValue(shellWorkspaceAtom)
  const entry = activeEntry(workspace)
  const keys = entry === null ? [] : entryViews(entry)
  const retained = useRetainedSurfaces(keys, (tab, visible) =>
    tab === 'away' ? null : (
      <TabView
        tab={tab}
        visible={visible}
        settingsNavInSidebar={false}
        onOpen={() => {}}
        onOpenBeside={() => {}}
        onMoved={() => {}}
        onNewDocument={() => {}}
        onOpenSearch={() => {}}
      />
    ),
  )
  return (
    <>
      <Button aria-label="Outside app">Outside</Button>
      {keys.map((key) => (
        <div key={key}>{retained.slot(key)}</div>
      ))}
      {retained.content}
    </>
  )
}

export function mountVaultAppShell(surface: Surface) {
  const store = createStore()
  const paths = ['Team/One.app', 'Team/Two.app']
  const install = (enabled: boolean) =>
    store.set(coreContributionAtom, { surfaces: enabled ? [surface] : [], rail: [], claims: [] })
  store.set(activeRemoteAtom, 'mara/notes')
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    files: paths.flatMap((path) => [
      { path: `${path}/index.html`, updatedAt: 'v1' },
      { path: `${path}/app.yaml`, updatedAt: 'v1' },
    ]),
  })
  install(true)
  // Both open but unvisited: rendering the shell must not execute either.
  store.set(shellWorkspaceAtom, (ws) =>
    selectEntry(openTab(openTab(openTab(ws, paths[0]!), paths[1]!), 'away'), 'away'),
  )
  const view = render(
    <Provider store={store}>
      <RetainedTabs />
    </Provider>,
  )
  return {
    ...view,
    paths,
    show: (path = paths[0]!) => act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, path))),
    away: () => act(() => store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, 'away'))),
    split: () => act(() => store.set(shellWorkspaceAtom, (ws) => openInSplit(ws, paths[0]!))),
    separate: () =>
      act(() => store.set(shellWorkspaceAtom, (ws) => separate(ws, activeSplit(ws)!.id))),
    close: () => act(() => store.set(shellWorkspaceAtom, (ws) => closeTab(ws, paths[0]!))),
    install: (enabled: boolean) => act(() => install(enabled)),
    depart: () => act(() => store.set(activeRemoteAtom, 'mara/other')),
    frame: (name: string) =>
      document.querySelector<HTMLIFrameElement>(`iframe[aria-label="${name}"]`),
  }
}
