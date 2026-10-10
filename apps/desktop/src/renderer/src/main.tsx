import { checkPluginCatalogue } from '@holi/shared'
import { Provider, createStore } from 'jotai'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { TooltipProvider } from './primitives'
import { flushAllBuffers } from './lib/buffer-registry'
import { CORE_CONTRIBUTION } from './components/core-surfaces'
import { coreContributionAtom, hostPluginVaults, installedPluginsAtom } from './state/plugins'
import { reportUiToMain } from './state/ui-report'
import { watchPendingSkills } from './state/skills'
import { subscribeToUpdates } from './state/updates'
import { subscribeToVault } from './state/vaults'
import { RENDERER_PLUGINS } from '../../plugins/renderer'
import './index.css'

/** One store, so the push subscriptions outlive every component: one owned by
 *  a component would stop when it unmounts and the vault would go quietly
 *  stale. */
const store = createStore()
// The plugins this build has: the one place the renderer imports them. Core's
// own surfaces go in beside them.
checkPluginCatalogue(RENDERER_PLUGINS.map((p) => p.info))
store.set(installedPluginsAtom, RENDERER_PLUGINS)
store.set(coreContributionAtom, CORE_CONTRIBUTION)
subscribeToVault(store, RENDERER_PLUGINS)
subscribeToUpdates(store)
watchPendingSkills(store)
hostPluginVaults(store)
reportUiToMain(store)

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
