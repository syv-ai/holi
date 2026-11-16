import { Provider, createStore } from 'jotai'
import '@/index.css'
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { emptyVaultSnapshot } from '@holi/shared'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FilesSection } from '@/features/sidebar/files-section'
import { activeRemoteAtom, showHiddenByVaultAtom, snapshotAtom, vaultsAtom } from '@/state/vaults'

const remote = 'smoke/files-subscriptions'
const store = createStore()
store.set(activeRemoteAtom, remote)
store.set(showHiddenByVaultAtom, { [remote]: true })
store.set(vaultsAtom, [
  {
    remote,
    path: window.fileSmoke.vaultRoot,
    name: 'files-subscriptions',
    lastOpenedAt: '2026-11-15T00:00:00Z',
  },
])

function App() {
  useEffect(() => {
    store.set(showHiddenByVaultAtom, { [remote]: true })
    void window.fileSmoke.snapshot().then((snapshot) => store.set(snapshotAtom, snapshot))
  }, [])
  return (
    <Provider store={store}>
      <TooltipProvider>
        <SidebarProvider defaultOpen>
          <main className="flex h-screen w-screen bg-background p-4 text-foreground">
            <aside className="flex h-full w-72 flex-col">
              <FilesSection activeId={null} onOpen={() => undefined} onMoved={() => undefined} />
            </aside>
          </main>
        </SidebarProvider>
      </TooltipProvider>
    </Provider>
  )
}

createRoot(document.getElementById('root')!).render(<App />)

declare global {
  interface Window {
    fileSmoke: {
      vaultRoot: string
      snapshot: () => Promise<ReturnType<typeof emptyVaultSnapshot>>
    }
  }
}
