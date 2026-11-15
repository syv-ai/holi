import { Provider } from 'jotai'
import { createStore } from 'jotai/vanilla'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { activeRemoteAtom } from '@/plugin-api'
import { vaultSettingsAtom } from '@/state/settings'
import { resolveVaultSettings } from '@holi/shared'
import { refreshGoogleAtom } from '../src/plugins/google/renderer/account'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConnectionsSection } from '../src/plugins/google/renderer/connections-section'
import { MailView } from '../src/plugins/google/renderer/mail-view'
import { MailShell } from '../src/plugins/google/renderer/mail/mail-shell'
import '../src/renderer/src/index.css'

const store = createStore()
store.set(activeRemoteAtom, 'smoke/vault')
store.set(vaultSettingsAtom, {
  remote: 'smoke/vault',
  settings: resolveVaultSettings(
    { app: null, appLocal: null, plugins: null, pluginsLocal: null },
    [],
  ),
})
let fixtureAccount = 'smoke-account-a'
const summaries = [
  {
    id: 'thread-yellow',
    subject: 'Yellow marker fixture',
    from: { name: 'Fixture', email: 'fixture@gmail.com' },
    snippet: 'Synthetic mail',
    date: '2026-01-01T00:00:00.000Z',
    unread: false,
    answered: false,
    messageCount: 1,
    webUrl: 'https://mail.google.com/mail/u/0/#all/thread-yellow',
    starred: true,
    important: false,
    hasDraft: false,
    category: null,
    labels: [],
    hasInvite: false,
    unsubscribeUrl: null,
  },
  {
    id: 'thread-red',
    subject: 'Red marker fixture',
    from: { name: 'Fixture', email: 'fixture@gmail.com' },
    snippet: 'Synthetic mail',
    date: '2026-01-02T00:00:00.000Z',
    unread: false,
    answered: false,
    messageCount: 1,
    webUrl: 'https://mail.google.com/mail/u/0/#all/thread-red',
    starred: true,
    important: false,
    hasDraft: false,
    category: null,
    labels: [],
    hasInvite: false,
    unsubscribeUrl: null,
  },
  {
    id: 'thread-blue',
    subject: 'Blue marker fixture',
    from: { name: 'Fixture', email: 'fixture@gmail.com' },
    snippet: 'Synthetic mail',
    date: '2026-01-03T00:00:00.000Z',
    unread: false,
    answered: false,
    messageCount: 1,
    webUrl: 'https://mail.google.com/mail/u/0/#all/thread-blue',
    starred: true,
    important: false,
    hasDraft: false,
    category: null,
    labels: [],
    hasInvite: false,
    unsubscribeUrl: null,
  },
]
summaries.push({ ...summaries[0]!, id: 'thread-ordinary', subject: 'External Gmail star fixture' })

const invoke = async (op: {
  path: string
  input?: { remote?: string; name?: string; paramsJson?: string }
}) => {
  ;(window as unknown as { smokeCalls: unknown[] }).smokeCalls ??= []
  ;(window as unknown as { smokeCalls: unknown[] }).smokeCalls.push(op)
  if (op.path === 'cap.names')
    return (
      window as unknown as { markerSmoke: { run: (op: unknown) => Promise<unknown> } }
    ).markerSmoke.run(op)
  if (op.path !== 'cap.run') return { ok: false, message: `Unexpected smoke call: ${op.path}` }
  const input = op.input
  const params = input?.paramsJson ? JSON.parse(input.paramsJson) : {}
  const name = input?.name ?? ''
  if (
    new Set([
      'google.status',
      'google.allAccounts',
      'google.useAccount',
      'google.mailMarkerPreferences',
      'google.setMailMarkerPreferences',
      'google.mailMarkerAnnotations',
      'google.star',
      'google.mark-read',
      'google.imageSenders',
    ]).has(name)
  ) {
    const result = (await (
      window as unknown as { markerSmoke: { run: (op: unknown) => Promise<unknown> } }
    ).markerSmoke.run(op)) as { data?: { account?: { sub?: string } } }
    if (name === 'google.status' && result.data?.account?.sub)
      fixtureAccount = result.data.account.sub
    return result
  }
  const value =
    name === 'google.search'
      ? {
          threads: summaries.map((summary) => ({
            ...summary,
            subject: `${fixtureAccount === 'smoke-account-a' ? 'Account A' : 'Account B'} — ${summary.subject}`,
          })),
          nextPageToken: null,
          syncedAt: null,
        }
      : name === 'google.mailCounts'
        ? { unread: 0, total: summaries.length }
        : name === 'google.categoryCounts' || name === 'google.mailboxCounts'
          ? {}
          : name === 'google.contacts' ||
              name === 'google.sendAs' ||
              name === 'google.drafts' ||
              name === 'google.images'
            ? []
            : name === 'google.thread'
              ? {
                  id: params.id,
                  subject: `${fixtureAccount === 'smoke-account-a' ? 'Account A' : 'Account B'} — ${summaries.find((thread) => thread.id === params.id)?.subject ?? 'Fixture thread'}`,
                  webUrl: 'https://mail.google.com/mail/u/0/#all/fixture',
                  messages: [
                    {
                      id: 'message-1',
                      from: { name: 'Fixture', email: 'fixture@example.test' },
                      to: [],
                      cc: [],
                      bcc: [],
                      date: '2026-01-01T00:00:00.000Z',
                      subject: 'Fixture message',
                      body: `Synthetic message body for ${fixtureAccount}.`,
                      html: null,
                      attachments: [],
                    },
                  ],
                }
              : name === 'google.client'
                ? { source: 'none', id: null }
                : null
  return { ok: true, data: value }
}
;(window as unknown as { holi: { trpc: typeof invoke } }).holi = { trpc: invoke }
;(window as unknown as { smokeRefresh: () => void }).smokeRefresh = () =>
  store.set(refreshGoogleAtom)

window.addEventListener('error', (event) => {
  ;(window as unknown as { smokeErrors: string[] }).smokeErrors ??= []
  ;(window as unknown as { smokeErrors: string[] }).smokeErrors.push(event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  ;(window as unknown as { smokeErrors: string[] }).smokeErrors ??= []
  ;(window as unknown as { smokeErrors: string[] }).smokeErrors.push(String(event.reason))
})

function App() {
  const [view, setView] = useState('connections')
  useEffect(() => {
    ;(window as unknown as { smokeShow: (view: string) => void }).smokeShow = setView
  }, [])
  return (
    <Provider store={store}>
      <TooltipProvider>
        <main className="flex h-screen flex-col gap-4 overflow-hidden bg-background p-4 text-foreground">
          <nav className="flex gap-2" aria-label="Native fixture surfaces">
            <Button variant="outline" size="sm" onClick={() => setView('connections')}>
              Connections
            </Button>
            <Button variant="outline" size="sm" onClick={() => setView('shell')}>
              Sidebar mail
            </Button>
            <Button variant="outline" size="sm" onClick={() => setView('surface')}>
              Mail surface
            </Button>
          </nav>
          <section
            hidden={view !== 'connections'}
            aria-label="Production connections settings"
            className="min-h-0 flex-1 overflow-auto"
          >
            <ConnectionsSection />
          </section>
          <section
            hidden={view !== 'shell'}
            aria-label="Production app-shell mail"
            className="min-h-0 flex-1"
          >
            <MailShell />
          </section>
          <section
            hidden={view !== 'surface'}
            aria-label="Production legacy mail reader"
            className="min-h-0 flex-1"
          >
            <MailView />
          </section>
        </main>
      </TooltipProvider>
    </Provider>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
