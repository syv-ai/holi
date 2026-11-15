import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'jotai'
import { createStore } from 'jotai/vanilla'
import { emptyVaultSnapshot } from '@holi/shared'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FilesSection } from '@/features/sidebar/files-section'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '@/state/vaults'
import '../src/renderer/src/index.css'

const store = createStore()
store.set(activeRemoteAtom, 'fixture/folder-bells')
store.set(vaultsAtom, [
  {
    remote: 'fixture/folder-bells',
    path: '/tmp/holi-folder-bells-vault',
    name: 'fixture',
    lastOpenedAt: null,
  },
] as never)
store.set(snapshotAtom, {
  ...emptyVaultSnapshot(),
  dirs: ['parent', 'parent/nested', 'a-long-folder-name-to-test-row-geometry'],
  docs: [
    { path: 'parent/first.md', title: 'First', updatedAt: '2026-11-15T00:00:00Z' },
    { path: 'parent/nested/inside.md', title: 'Inside', updatedAt: '2026-11-15T00:00:00Z' },
  ] as never,
})

function Smoke() {
  useEffect(() => {
    document.documentElement.dataset.theme = 'dark'
    document.body.style.cssText =
      'margin:0; padding:24px; width:480px; height:700px; overflow:hidden'
    window.__folderBellReady = true
  }, [])

  return (
    <Provider store={store}>
      <TooltipProvider>
        <SidebarProvider>
          <main className="h-[640px] w-[430px] border p-4">
            <FilesSection activeId={null} onOpen={() => undefined} onMoved={() => undefined} />
          </main>
        </SidebarProvider>
      </TooltipProvider>
    </Provider>
  )
}

export default Smoke

createRoot(document.getElementById('root')!).render(<Smoke />)

declare global {
  interface Window {
    __folderBellReady?: boolean
    __folderBellCalls?: { path: string; enabled: boolean }[]
  }
}

window.__folderBellCalls = []
