import { Provider, createStore } from 'jotai'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { TooltipProvider } from './primitives'
import { flushAllBuffers } from './lib/buffer-registry'
import { subscribeToVault } from './state/vaults'
import './index.css'

/** One store for the app, so the push subscriptions below can outlive every
 *  component. A subscription owned by a component stops the moment that
 *  component is conditionally rendered away, and the vault then goes quietly
 *  stale rather than visibly broken. */
const store = createStore()
subscribeToVault(store)

/**
 * Main is quitting and wants the buffer on disk before it commits (FR-6).
 *
 * Subscribed here rather than in the editor, because it has to answer even when
 * no editor is open — a window sitting on the sign-in screen still gets asked,
 * and silence costs a second on every quit. `flushAllBuffers` resolves
 * immediately when nothing is registered.
 *
 * The ack fires unconditionally. Main waits one second and then quits either
 * way, so a failed write must not also cost the pause.
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
