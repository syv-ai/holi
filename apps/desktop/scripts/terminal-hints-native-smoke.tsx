import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider, useSetAtom } from 'jotai'
import { BottomPanel } from '../src/renderer/src/features/bottom-panel/bottom-panel'
import { HostHintLayer } from '../src/renderer/src/features/shell/host-hint-layer'
import { useShortcutDispatcher } from '../src/renderer/src/hooks/use-shortcuts'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../src/renderer/src/components/ui/dialog'
import { useState } from 'react'
import { vimCodeEditingAtom } from '../src/renderer/src/state/preferences'
import { bottomPanelAtom } from '../src/renderer/src/state/bottom-panel'
import { activeRemoteAtom } from '../src/renderer/src/state/vaults'
import { usePanelTerminals } from '../src/renderer/src/state/panel-terminals'
import '../src/renderer/src/index.css'

const store = createStore()
;(
  window as unknown as Window & {
    __holiNativeSmokeSetVim: (enabled: boolean) => void
    __holiNativeSmokeSetDialog: (open: boolean) => void
  }
).__holiNativeSmokeSetVim = (enabled) => store.set(vimCodeEditingAtom, enabled)
;(
  window as unknown as Window & { __holiNativeSmokeSetRemote: (remote: string) => void }
).__holiNativeSmokeSetRemote = (remote) => store.set(activeRemoteAtom, remote)

function Fixture() {
  const [dialogOpen, setDialogOpen] = useState(false)
  ;(
    window as unknown as Window & { __holiNativeSmokeSetDialog: (open: boolean) => void }
  ).__holiNativeSmokeSetDialog = setDialogOpen
  useShortcutDispatcher()
  const setVim = useSetAtom(vimCodeEditingAtom)
  const setPanel = useSetAtom(bottomPanelAtom)
  const setRemote = useSetAtom(activeRemoteAtom)
  usePanelTerminals()
  useEffect(() => {
    setVim(true)
    setPanel({ open: true, tab: 'terminal', maximized: false })
    setRemote('native-smoke')
  }, [setVim, setPanel, setRemote])
  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col">
        <main className="min-h-0 flex-1" />
        <BottomPanel onRetryOutput={() => {}} />
        <HostHintLayer scopeKey="native-smoke" />
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Native smoke dialog</DialogTitle>
              <DialogDescription>Foreground dialog precedence fixture.</DialogDescription>
            </DialogHeader>
            <button
              type="button"
              aria-label="Close smoke dialog"
              onClick={() => setDialogOpen(false)}
            >
              Close
            </button>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <Fixture />
  </Provider>,
)
