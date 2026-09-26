import { Provider, createStore } from 'jotai'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { TooltipProvider } from './primitives'
import { flushAllBuffers } from './lib/buffer-registry'
import { subscribeToVault } from './state/vaults'
import './index.css'

/** One store, so the push subscriptions outlive every component: one owned by
 *  a component would stop when it unmounts and the vault would go quietly
 *  stale. */
const store = createStore()
subscribeToVault(store)

/**
 * Main is quitting and wants buffers on disk before it commits. Subscribed
 * here, not in the editor, so it answers with no editor open. The ack fires
 * unconditionally: main quits after a second either way.
 */
window.holi.vault.onFlushRequest(() => {
  void flushAllBuffers().finally(() => window.holi.vault.flushDone())
})

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </Provider>
  </React.StrictMode>,
)
