import { createRoot } from 'react-dom/client'
import { createStore, Provider } from 'jotai'
import { PluginFrame } from '../src/plugins/community/renderer/plugin-frame'
import { rowsAtom } from '../src/plugins/community/renderer/state'
import { activeRemoteAtom } from '../src/renderer/src/state/vaults'
import { vimCodeEditingAtom } from '../src/renderer/src/state/preferences'
import { HostHintLayer } from '../src/renderer/src/features/shell/host-hint-layer'
import '../src/renderer/src/index.css'

const store = createStore()
const api = (window as any).holiSmoke
void api.call('community.list').then((rows: unknown) => {
  store.set(rowsAtom, { remote: 'native-community-smoke', rows })
  store.set(activeRemoteAtom, 'native-community-smoke')
  store.set(vimCodeEditingAtom, true)
})

createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <main data-pane-focused className="h-screen w-screen">
      <PluginFrame path="slides.md" />
      <HostHintLayer scopeKey="native-community-smoke" />
    </main>
  </Provider>,
)
