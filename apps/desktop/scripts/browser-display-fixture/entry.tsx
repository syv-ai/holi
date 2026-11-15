import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { BrowserSurface } from '../../src/plugins/browser/renderer/browser-surface'
import { browserEvents, pagesAtom, vimModesAtom } from '../../src/plugins/browser/renderer/state'
import { activeRemoteAtom, vimCodeEditingAtom } from '../../src/renderer/src/plugin-api/index'
import '../../src/renderer/src/index.css'
const store = createStore()
store.set(activeRemoteAtom, 'A')
window.qaPlatform.onEvent((event) => browserEvents[event.name]?.(event, store))
function Fixture() {
  const [visible, setVisible] = useState(true)
  const [overlay, setOverlay] = useState(false)
  window.qa = {
    setVim: (value) => store.set(vimCodeEditingAtom, value),
    setVisible,
    setOverlay,
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
        <BrowserSurface id="same" visible={visible && !overlay} />
        {overlay ? (
          <div
            role="dialog"
            aria-label="Native acceptance overlay"
            style={{ position: 'fixed', inset: 80, background: 'var(--background)', zIndex: 100 }}
          >
            Temporary overlay
          </div>
        ) : null}
      </TooltipProvider>
    </Provider>
  )
}
createRoot(document.getElementById('root')).render(<Fixture />)
