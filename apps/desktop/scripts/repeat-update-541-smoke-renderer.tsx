import { createRoot } from 'react-dom/client'
import { createStore, Provider } from 'jotai'
import { SidebarProvider } from '../src/renderer/src/components/ui/sidebar'
import { AccountMenu } from '../src/renderer/src/features/sidebar/account-menu'
import { ReadyUpdateDialog } from '../src/renderer/src/features/shell/ready-update-dialog'
import { sessionAtom } from '../src/renderer/src/state/session'
import { subscribeToUpdates } from '../src/renderer/src/state/updates'
import { listenForQuitFlush } from '../src/renderer/src/lib/quit-flush'
import './repeat-update-541-smoke.css'

const store = createStore()
store.set(sessionAtom, { login: 'fixture-user', name: 'Synthetic update account' })
subscribeToUpdates(store)
listenForQuitFlush(window.holi.vault)
createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <SidebarProvider>
      <AccountMenu collapsed />
      <ReadyUpdateDialog />
    </SidebarProvider>
  </Provider>,
)
