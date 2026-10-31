import { checkPluginCatalogue } from '@holi/shared'
import { Provider, createStore } from 'jotai'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@/App'
import { ReadyUpdateDialog } from '@/features/shell/ready-update-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { flushAllBuffers } from '@/lib/buffer-registry'
import { stampPlatform } from '@/lib/platform'
import { hostPluginVaults, installedPluginsAtom } from '@/state/plugins'
import { reportUiToMain } from '@/state/ui-report'
import { watchPendingSkills } from '@/state/skills'
import { subscribeToUpdates } from '@/state/updates'
import { subscribeToVault } from '@/state/vaults'
import { RENDERER_PLUGINS } from '../../plugins/renderer'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './index.css'

/** One store, so the push subscriptions outlive every component: one owned by
 *  a component would stop when it unmounts and the vault would go quietly
 *  stale. */
const store = createStore()
stampPlatform()
// Fullscreen hides the lights, and the room kept for them with them.
window.holi.window.onFullScreen((on) => {
  if (on) document.documentElement.dataset.fullscreen = ''
  else delete document.documentElement.dataset.fullscreen
})
// The plugins this build has: the one place the renderer imports them.
checkPluginCatalogue(RENDERER_PLUGINS.map((p) => p.info))
store.set(installedPluginsAtom, RENDERER_PLUGINS)
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
        <ReadyUpdateDialog />
      </TooltipProvider>
    </Provider>
  </React.StrictMode>,
)
