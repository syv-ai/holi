import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider } from 'jotai'
import { PluginFrame } from '../src/plugins/community/renderer/plugin-frame'
import { rowsAtom, type PluginRow } from '../src/plugins/community/renderer/state'
import { activeRemoteAtom } from '../src/renderer/src/state/vaults'
import { vimCodeEditingAtom } from '../src/renderer/src/state/preferences'
import { HostHintLayer } from '../src/renderer/src/features/shell/host-hint-layer'
import { useShortcutDispatcher } from '../src/renderer/src/hooks/use-shortcuts'
import { Button } from '../src/renderer/src/components/ui/button'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'
import '../src/renderer/src/index.css'

const remote = 'syv-ai/native-community-smoke'
const store = createStore()
const api = (
  window as unknown as { holiSmoke: { call(name: string, params?: unknown): Promise<unknown> } }
).holiSmoke
async function refresh() {
  const rows = (await api.call('community.list')) as PluginRow[]
  store.set(rowsAtom, { remote, rows })
}
store.set(activeRemoteAtom, remote)
store.set(vimCodeEditingAtom, true)
let show: (value: boolean) => void = () => undefined
Object.assign(window, {
  communitySmoke: {
    vim: (enabled: boolean) => store.set(vimCodeEditingAtom, enabled),
    visible: (visible: boolean) => show(visible),
    refresh,
  },
})
function Fixture() {
  const [visible, setVisible] = useState(true)
  show = setVisible
  useShortcutDispatcher()
  return (
    <TooltipProvider>
      <main data-pane="" className="flex h-screen flex-col gap-3 bg-background p-4 text-foreground">
        <Button variant="secondary" onClick={() => undefined}>
          Host action
        </Button>
        <div hidden={!visible} className="min-h-0 flex-1">
          <PluginFrame path="slides.md" visible={visible} />
        </div>
        <HostHintLayer scopeKey={remote} />
      </main>
    </TooltipProvider>
  )
}
void refresh().then(() =>
  createRoot(document.getElementById('root')!).render(
    <Provider store={store}>
      <Fixture />
    </Provider>,
  ),
)
