import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { BrowserSurface } from '../../src/plugins/browser/renderer/browser-surface'
import { browserEvents, pagesAtom, vimModesAtom } from '../../src/plugins/browser/renderer/state'
import { activeRemoteAtom, vimCodeEditingAtom } from '../../src/renderer/src/plugin-api/index'
import { HostHintLayer } from '../../src/renderer/src/features/shell/host-hint-layer'
import { useShortcutDispatcher } from '../../src/renderer/src/hooks/use-shortcuts'
import '../../src/renderer/src/index.css'
const store = createStore()
store.set(activeRemoteAtom, 'A')
window.qaPlatform.onEvent((event) => browserEvents[event.name]?.(event, store))
function ShortcutDispatcher() {
  useShortcutDispatcher()
  return null
}
function Fixture() {
  const [visible, setVisible] = useState(true)
  const [overlay, setOverlay] = useState(false)
  const [otherPane, setOtherPane] = useState(false)
  window.qa = {
    setVim: (value) => store.set(vimCodeEditingAtom, value),
    setVisible,
    setOverlay,
    setOtherPane,
    setRemote: (value) => store.set(activeRemoteAtom, value),
    state: () => ({
      modes: store.get(vimModesAtom),
      pages: store.get(pagesAtom),
      badge: document.querySelector('[aria-label^="Vim "]')?.textContent ?? null,
    }),
  }
  return (
    <Provider store={store}>
      <TooltipProvider>
        <ShortcutDispatcher />
        <div style={{ display: 'flex', width: '100%', height: '100%' }}>
          <div data-pane data-pane-focused style={{ flex: 1, minWidth: 0 }}>
            <BrowserSurface id="same" visible={visible && !overlay} />
          </div>
          {otherPane ? (
            <div data-pane style={{ flex: 1, minWidth: 0 }}>
              <BrowserSurface id="other" visible={visible && !overlay} />
            </div>
          ) : null}
        </div>
        {overlay ? (
          <div
            role="dialog"
            aria-label="Native acceptance overlay"
            style={{ position: 'fixed', inset: 80, background: 'var(--background)', zIndex: 100 }}
          >
            Temporary overlay
          </div>
        ) : null}
        <HostHintLayer scopeKey="browser-display-native" />
      </TooltipProvider>
    </Provider>
  )
}
createRoot(document.getElementById('root')).render(<Fixture />)
