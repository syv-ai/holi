import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider, useAtomValue } from 'jotai'
import { communityRenderer } from '../src/plugins/community/renderer'
import { PluginFrame } from '../src/plugins/community/renderer/plugin-frame'
import { rowsAtom, type PluginRow } from '../src/plugins/community/renderer/state'
import { transcribeRenderer } from '../src/plugins/transcribe/renderer'
import {
  MEETINGS_SURFACE,
  meetingsAtom,
  profilesAtom,
} from '../src/plugins/transcribe/renderer/state'
import { useRetainedSurfaces } from '../src/renderer/src/features/shell/retained-surfaces'
import { tabKey } from '../src/renderer/src/state/tab-descriptor'
import { coreContributionAtom } from '../src/renderer/src/state/plugins'
import { colorSchemeAtom } from '../src/renderer/src/state/color-scheme'
import { activeRemoteAtom } from '../src/renderer/src/state/vaults'
import { openTabAtom, shellWorkspaceAtom } from '../src/renderer/src/state/shell-tabs'
import { closeTab } from '../src/renderer/src/state/shell-workspace'
import { vimCodeEditingAtom } from '../src/renderer/src/state/preferences'
import { HostHintLayer } from '../src/renderer/src/features/shell/host-hint-layer'
import { useShortcutDispatcher } from '../src/renderer/src/hooks/use-shortcuts'
import { Button } from '../src/renderer/src/components/ui/button'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'
import '../src/renderer/src/index.css'

const remote = 'syv-ai/native-community-smoke'
const documentPath = 'slides.fixture'
const meetingsKey = tabKey({ kind: 'surface', surface: MEETINGS_SURFACE })
const meetingFolder = 'Weekly review.meeting'
const meetingFolderKey = tabKey({ kind: 'surface', surface: MEETINGS_SURFACE, id: meetingFolder })
const store = createStore()
const navigation: [string, string[]][] = [
  ['Slides fixture', [documentPath]],
  ['Meetings', [meetingsKey]],
  ['Meeting folder', [meetingFolderKey]],
  ['Split views', [documentPath, meetingsKey]],
  ['Split meeting folder', [documentPath, meetingFolderKey]],
]
const api = (
  window as unknown as {
    holiSmoke: { retention: boolean; call(name: string, params?: unknown): Promise<unknown> }
  }
).holiSmoke
async function refresh() {
  const rows = (await api.call('community.list')) as PluginRow[]
  store.set(rowsAtom, { remote, rows })
}
store.set(activeRemoteAtom, remote)
store.set(vimCodeEditingAtom, true)
const meetings = transcribeRenderer.surfaces!.find((surface) => surface.kind === MEETINGS_SURFACE)!
if (api.retention) {
  store.set(coreContributionAtom, { surfaces: [meetings], rail: [], claims: [] })
  for (const tab of [
    { kind: 'doc' as const, path: documentPath },
    { kind: 'surface' as const, surface: MEETINGS_SURFACE },
    { kind: 'surface' as const, surface: MEETINGS_SURFACE, id: meetingFolder },
  ])
    store.set(openTabAtom, tab)
  // Offline data at the plugin's ordinary store seam; no recording is started.
  store.set(meetingsAtom, [])
  store.set(profilesAtom, [
    {
      id: 'fixture',
      name: 'Planning',
      platform: 'Holi',
      focus: '',
      ignore: '',
      glossary: [],
      instructions: '',
      language: 'en',
      shareMinutes: false,
      keepAudio: false,
    },
  ])
}
let navigate: (keys: string[]) => void = () => undefined
Object.assign(window, {
  communitySmoke: {
    vim: (enabled: boolean) => store.set(vimCodeEditingAtom, enabled),
    theme: (scheme: 'light' | 'dark') => {
      store.set(colorSchemeAtom, scheme)
      document.documentElement.dataset.theme = scheme
      document.documentElement.style.colorScheme = scheme
    },
    visible: (visible: boolean) => navigate(visible ? [documentPath] : [meetingsKey]),
    refresh,
    close: () => {
      store.set(shellWorkspaceAtom, (workspace) => closeTab(workspace, documentPath))
      navigate([meetingsKey])
    },
    reopen: () => {
      store.set(openTabAtom, { kind: 'doc', path: documentPath })
      navigate([documentPath])
    },
    closeMeeting: () => {
      store.set(shellWorkspaceAtom, (workspace) => closeTab(workspace, meetingFolderKey))
      navigate([documentPath])
    },
    reopenMeeting: () => {
      store.set(openTabAtom, { kind: 'surface', surface: MEETINGS_SURFACE, id: meetingFolder })
      navigate([meetingFolderKey])
    },
    depart: () => {
      store.set(activeRemoteAtom, null)
      navigate([])
    },
  },
})
function RetentionFixture() {
  const [active, setActive] = useState<string[]>([documentPath])
  navigate = setActive
  const contribution = communityRenderer.claims
  if (!contribution || !('read' in contribution))
    throw new Error('Expected dynamic community claims')
  const claims = useAtomValue(contribution)
  const claim = claims.find((candidate) => candidate.match(documentPath))
  const retained = useRetainedSurfaces(
    active,
    (key, visible) => {
      if (key === documentPath) {
        const View = claim?.view
        return View ? <View path={documentPath} visible={visible} /> : null
      }
      const Surface = meetings.render
      return (
        <Surface {...(key === meetingFolderKey ? { id: meetingFolder } : {})} visible={visible} />
      )
    },
    (key) => key === documentPath && claim?.retainView === true,
  )
  return (
    <main className="flex h-screen flex-col gap-3 bg-background p-4 text-foreground">
      <div className="flex gap-2">
        {navigation.map(([label, keys]) => (
          <Button key={label} variant="secondary" onClick={() => setActive(keys)}>
            {label}
          </Button>
        ))}
      </div>
      {retained.content}
      <div className="flex min-h-0 flex-1 gap-3">
        {active.map((key) => (
          <section key={key} data-pane-slot={key} className="min-h-0 min-w-0 flex-1">
            {retained.slot(key)}
          </section>
        ))}
      </div>
    </main>
  )
}
function HintFixture() {
  const [visible, setVisible] = useState(true)
  navigate = (keys) => setVisible(keys.includes(documentPath))
  useShortcutDispatcher()
  return (
    <main
      data-pane=""
      data-pane-focused="true"
      className="flex h-screen flex-col gap-3 bg-background p-4 text-foreground"
    >
      <Button variant="secondary" onClick={() => undefined}>
        Host action
      </Button>
      <div hidden={!visible} className="min-h-0 flex-1">
        <PluginFrame path={documentPath} visible={visible} />
      </div>
      <HostHintLayer scopeKey={remote} />
    </main>
  )
}
void refresh().then(() =>
  createRoot(document.getElementById('root')!).render(
    <Provider store={store}>
      <TooltipProvider>{api.retention ? <RetentionFixture /> : <HintFixture />}</TooltipProvider>
    </Provider>,
  ),
)
