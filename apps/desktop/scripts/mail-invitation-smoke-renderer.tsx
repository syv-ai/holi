import { Provider } from 'jotai'
import { createStore } from 'jotai/vanilla'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { resolveVaultSettings } from '@holi/shared'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { activeRemoteAtom } from '@/plugin-api'
import { vaultSettingsAtom } from '@/state/settings'
import { MailView } from '../src/plugins/google/renderer/mail-view'
import { MailShell } from '../src/plugins/google/renderer/mail/mail-shell'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '../src/renderer/src/index.css'
import defaultThemeCss from '../src/main/vault/seed/vault/once/.holi/settings/theme.css?raw'

const theme = document.createElement('style')
theme.textContent = defaultThemeCss
document.head.append(theme)
const store = createStore()
const remote = 'smoke/invitations'
store.set(activeRemoteAtom, remote)
store.set(vaultSettingsAtom, {
  remote,
  settings: resolveVaultSettings(
    { app: null, appLocal: null, plugins: null, pluginsLocal: null },
    [],
  ),
})

Object.assign(window, { fixtureErrors: [] as string[], fixtureClicks: [] as string[] })
window.addEventListener('error', (event) => window.fixtureErrors.push(event.message))
window.addEventListener('unhandledrejection', (event) =>
  window.fixtureErrors.push(String(event.reason)),
)
document.addEventListener(
  'click',
  (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return
    const button = event.target.closest('button, [role="menuitem"], a')
    if (button)
      window.fixtureClicks.push(
        button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '',
      )
  },
  true,
)

declare global {
  interface Window {
    fixtureErrors: string[]
    fixtureClicks: string[]
  }
}

function App() {
  const [view, setView] = useState<'shell' | 'surface'>('shell')
  return (
    <Provider store={store}>
      <TooltipProvider>
        <main className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
          <nav className="flex gap-2 p-2" aria-label="Fixture surfaces">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={view === 'shell'}
              onClick={() => setView('shell')}
            >
              Sidebar mail
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={view === 'surface'}
              onClick={() => setView('surface')}
            >
              Mail surface
            </Button>
          </nav>
          {view === 'shell' ? (
            <section aria-label="Production MailShell" className="min-h-0 flex-1">
              <MailShell />
            </section>
          ) : (
            <section aria-label="Production MailView" className="min-h-0 flex-1">
              <MailView />
            </section>
          )}
        </main>
      </TooltipProvider>
    </Provider>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
