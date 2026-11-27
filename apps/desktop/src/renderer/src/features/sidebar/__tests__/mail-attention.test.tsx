import { act, render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { SidebarMenu, SidebarProvider } from '@/components/ui/sidebar'
import { SidebarAppItem, useSidebarApps } from '@/features/sidebar/sidebar-apps'
import { installedPluginsAtom } from '@/state/plugins'
import { activeRemoteAtom } from '@/state/vaults'
// This integration test installs the real Google contribution; production core stays plugin-free.
// eslint-disable-next-line no-restricted-imports
import { googleRenderer } from '../../../../../plugins/google/renderer/index'
// eslint-disable-next-line no-restricted-imports
import {
  MAIL_ATTENTION_EVENT,
  type MailAttentionSnapshot,
} from '../../../../../plugins/google/shared/types'

const mailAttention = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: {
      run: {
        mutate: async ({ name, remote }: { name: string; remote: string }) => {
          if (name === 'google.status')
            return {
              account: { sub: 'sub-a', email: 'ada@syv.ai' },
              missingScopes: [],
              needsReconnect: false,
            }
          if (name === 'google.allAccounts')
            return {
              accounts: [{ sub: 'sub-a', email: 'ada@syv.ai' }],
              current: 'sub-a',
            }
          if (name === 'google.mailAttention') return mailAttention(remote)
          throw new Error(`unexpected ${name}`)
        },
      },
    },
  },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function snapshot(
  revision: number,
  unreadThreads: number | null,
  status: MailAttentionSnapshot['status'] = 'fresh',
): MailAttentionSnapshot {
  return {
    accountSub: status === 'disconnected' ? null : 'sub-a',
    unreadThreads,
    status,
    revision,
    updatedAt: status === 'fresh' || status === 'stale' ? '2026-11-25T08:00:00.000Z' : null,
  }
}

function RegisteredMail({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  const app = useSidebarApps().find((candidate) => candidate.id === 'mail')
  if (app === undefined) return <></>
  return (
    <SidebarMenu>
      <SidebarAppItem app={app} active={false} collapsed={collapsed} onSelect={() => undefined} />
    </SidebarMenu>
  )
}

function mount(store: ReturnType<typeof createStore>, collapsed: boolean) {
  return render(
    <Provider store={store}>
      <SidebarProvider defaultOpen={!collapsed}>
        <RegisteredMail collapsed={collapsed} />
      </SidebarProvider>
    </Provider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

test('the registered Mail sidebar shows only a fresh unread count before Mail opens', async () => {
  const user = userEvent.setup()
  const bootstrap = deferred<MailAttentionSnapshot>()
  mailAttention.mockReturnValueOnce(bootstrap.promise)
  const store = createStore()
  store.set(activeRemoteAtom, 'owner/vault')
  store.set(installedPluginsAtom, [googleRenderer])
  const stop = googleRenderer.vault!('owner/vault', store)
  const handler = googleRenderer.events![MAIL_ATTENTION_EVENT]!

  const expanded = mount(store, false)
  await screen.findByRole('button', { name: 'Mail' })
  act(() => handler({ remote: 'owner/vault', payload: snapshot(2, 7) }, store))
  expect(await screen.findByRole('button', { name: 'Mail, 7 unread threads' })).toBeInTheDocument()
  expect(
    screen.getByText('7', { selector: '[data-slot="sidebar-menu-badge"]' }),
  ).toBeInTheDocument()

  bootstrap.resolve(snapshot(1, 2))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Mail, 7 unread threads' })).toBeInTheDocument(),
  )

  act(() => handler({ remote: 'owner/vault', payload: snapshot(3, null, 'unknown') }, store))
  expect(screen.getByRole('button', { name: 'Mail' })).toBeInTheDocument()
  expect(document.querySelector('[data-slot="sidebar-menu-badge"]')).toBeNull()

  act(() => handler({ remote: 'owner/vault', payload: snapshot(4, 0) }, store))
  expect(screen.getByRole('button', { name: 'Mail, no unread threads' })).toBeInTheDocument()
  expect(document.querySelector('[data-slot="sidebar-menu-badge"]')).toBeNull()

  act(() => handler({ remote: 'owner/vault', payload: snapshot(5, 9, 'stale') }, store))
  expect(screen.getByRole('button', { name: 'Mail' })).toBeInTheDocument()
  expect(document.querySelector('[data-slot="sidebar-menu-badge"]')).toBeNull()
  expanded.unmount()

  act(() => handler({ remote: 'owner/vault', payload: snapshot(6, 1) }, store))
  mount(store, true)
  const rail = await screen.findByRole('button', { name: 'Mail, 1 unread thread' })
  expect(
    screen.getByText('1', { selector: '[data-slot="sidebar-menu-badge"]' }),
  ).toBeInTheDocument()
  await user.hover(rail)
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Mail, 1 unread thread')
  stop()
})

test('a stale A bootstrap cannot replace the current A after a vault A-B-A lifecycle', async () => {
  const firstA = deferred<MailAttentionSnapshot>()
  const vaultB = deferred<MailAttentionSnapshot>()
  const secondA = deferred<MailAttentionSnapshot>()
  mailAttention
    .mockReturnValueOnce(firstA.promise)
    .mockReturnValueOnce(vaultB.promise)
    .mockReturnValueOnce(secondA.promise)
  const store = createStore()
  store.set(activeRemoteAtom, 'owner/a')
  store.set(installedPluginsAtom, [googleRenderer])

  const stopFirstA = googleRenderer.vault!('owner/a', store)
  stopFirstA()
  const stopB = googleRenderer.vault!('owner/b', store)
  stopB()
  const stopSecondA = googleRenderer.vault!('owner/a', store)
  googleRenderer.events![MAIL_ATTENTION_EVENT]!(
    { remote: 'owner/a', payload: snapshot(2, 4) },
    store,
  )

  firstA.resolve(snapshot(99, 99))
  vaultB.resolve(snapshot(50, 50))
  secondA.resolve(snapshot(1, 1))
  mount(store, false)
  expect(await screen.findByRole('button', { name: 'Mail, 4 unread threads' })).toBeInTheDocument()
  expect(screen.queryByText('99', { selector: '[data-slot="sidebar-menu-badge"]' })).toBeNull()
  stopSecondA()
})
