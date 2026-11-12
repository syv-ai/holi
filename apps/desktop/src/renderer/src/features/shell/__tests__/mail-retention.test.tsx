/**
 * The shell’s real retained-host and TabView composition with Google’s Mail
 * contribution. Gmail responses are synthetic; Mail state and DOM are real.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createStore, getDefaultStore, Provider, useAtomValue } from 'jotai'
import { emptyVaultSnapshot } from '@holi/shared'
import { Input } from '@/components/ui/input'
import { installedPluginsAtom } from '@/state/plugins'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { closeTab, emptyWorkspace, focusedTab, openTab, selectEntry } from '@/state/shell-workspace'
import { tabKey } from '@/state/tab-descriptor'
import { snapshotAtom } from '@/state/vaults'
import { TabView } from '@/features/shell/tab-view'
import { useRetainedSurfaces } from '@/features/shell/retained-surfaces'
// This shell integration test installs the actual Google contribution;
// production core remains plugin-free.
// eslint-disable-next-line no-restricted-imports
import { googleRenderer } from '../../../../../plugins/google/renderer/index'
import { activeRemoteAtom } from '@/plugin-api'

const searchMock = vi.fn()
const threadMock = vi.fn()
const draftsMock = vi.fn()
const markReadMock = vi.fn()
const starMock = vi.fn()
const archiveMock = vi.fn()
const trashMock = vi.fn()
const saveDraftMock = vi.fn()
const saveDraftAccounts: string[] = []
const useAccountMock = vi.fn()
const toastMock = vi.fn()
const openExternal = vi.fn()

let currentAccount = 'a'
const google: Record<string, (params: unknown) => unknown> = {
  status: () => ({
    account: {
      email: currentAccount === 'a' ? 'ada@syv.ai' : 'ada@home.test',
      sub: currentAccount,
    },
    missingScopes: [],
  }),
  allAccounts: () => ({
    accounts: [
      { sub: 'a', email: 'ada@syv.ai' },
      { sub: 'b', email: 'ada@home.test' },
    ],
    current: currentAccount,
  }),
  useAccount: (p) => useAccountMock(p),
  search: (p) => searchMock(p),
  thread: (p) => threadMock(p),
  drafts: () => draftsMock(),
  mailCounts: () => ({ unread: 2, total: 40 }),
  categoryCounts: () => ({}),
  contacts: () => [],
  sendAs: () => ['ada@syv.ai'],
  meeting: () => null,
  'mark-read': (p) => markReadMock(p),
  star: (p) => starMock(p),
  archive: (p) => archiveMock(p),
  trash: (p) => trashMock(p),
  saveDraft: (p) => {
    saveDraftAccounts.push(currentAccount)
    return saveDraftMock(p)
  },
  imageSenders: () => [],
  allowImagesFrom: () => ({ ok: true }),
  forgetImageSenders: () => ({ ok: true }),
}

vi.mock('sonner', async (original) => ({
  ...(await original<typeof import('sonner')>()),
  toast: (...args: unknown[]) => toastMock(...args),
}))

vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: {
      run: {
        mutate: async ({ name, paramsJson }: { name: string; paramsJson?: string }) => {
          const params = paramsJson === undefined ? undefined : JSON.parse(paramsJson)
          const verb = google[name.replace(/^google\./, '')]
          if (verb === undefined) throw new Error(`unexpected ${name}`)
          return verb(params)
        },
      },
    },
  },
}))

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    subject: 'Q2 budget',
    from: { name: 'Jane Doe', email: 'jane@example.com' },
    date: '2026-08-04T09:00:00.000Z',
    snippet: 'Numbers attached',
    unread: true,
    answered: false,
    messageCount: 2,
    webUrl: 'https://mail.google.com/x',
    starred: false,
    important: false,
    hasDraft: false,
    category: 'updates',
    labels: ['Finance'],
    hasInvite: false,
    unsubscribeUrl: null,
    ...overrides,
  }
}

function page(threads: unknown[], nextPageToken: string | null = null) {
  return { threads, nextPageToken, syncedAt: new Date().toISOString() }
}

const thread = {
  id: 't1',
  subject: 'Q2 budget',
  webUrl: 'https://mail.google.com/x',
  messages: [
    {
      id: 'm1',
      from: { name: 'Jane Doe', email: 'jane@example.com' },
      to: [{ name: 'Ada', email: 'ada@syv.ai' }],
      cc: [],
      bcc: [],
      date: '2026-08-04T09:00:00.000Z',
      body: 'Earlier note',
      html: null,
      attachments: [],
    },
    {
      id: 'm2',
      from: { name: 'Jane Doe', email: 'jane@example.com' },
      to: [{ name: 'Ada', email: 'ada@syv.ai' }],
      cc: [],
      bcc: [],
      date: '2026-08-04T10:00:00.000Z',
      body: 'See the sheet',
      html: '<p>See the <b>sheet</b></p><script>alert(1)</script>',
      attachments: [{ filename: 'q2.xlsx', mimeType: 'application/vnd.ms-excel', size: 20480 }],
    },
  ],
}

beforeEach(() => {
  currentAccount = 'a'
  searchMock.mockReset().mockResolvedValue(page([summary()]))
  threadMock.mockReset().mockResolvedValue(thread)
  draftsMock.mockReset().mockResolvedValue([])
  markReadMock.mockReset().mockResolvedValue({ ok: true })
  starMock.mockReset().mockResolvedValue({ ok: true })
  archiveMock.mockReset().mockResolvedValue({ ok: true })
  trashMock.mockReset().mockResolvedValue({ ok: true })
  saveDraftMock.mockReset().mockResolvedValue({ id: 'draft-1' })
  saveDraftAccounts.length = 0
  useAccountMock.mockReset().mockImplementation(({ sub }: { sub: string }) => {
    currentAccount = sub
    return { ok: true }
  })
  toastMock.mockReset()
  openExternal.mockReset()
  getDefaultStore().set(activeRemoteAtom, 'syv-ai/vault')
  // @ts-expect-error: the preload bridge is not typed onto window in tests.
  window.holi = { openExternal }
})
afterEach(() => {
  // @ts-expect-error: as above.
  delete window.holi
})

const mailKey = tabKey({ kind: 'app', id: 'mail' })
const otherKey = tabKey({ kind: 'app', id: 'other' })
const noop = () => undefined

/** The shell's real retained-host and TabView composition, with only Gmail faked. */
function MailTabs() {
  const workspace = useAtomValue(shellWorkspaceAtom)
  const key = focusedTab(workspace)
  const retained = useRetainedSurfaces(key === null ? [] : [key], (tab, visible) => (
    <TabView
      tab={tab}
      visible={visible}
      settingsNavInSidebar={false}
      onOpen={noop}
      onOpenBeside={noop}
      onMoved={noop}
      onNewDocument={noop}
      onOpenSearch={noop}
    />
  ))
  return (
    <div>
      {retained.content}
      {key !== null && retained.slot(key)}
    </div>
  )
}

function mountMailTabs(showMail = true) {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv-ai/vault')
  store.set(snapshotAtom, emptyVaultSnapshot())
  store.set(installedPluginsAtom, [
    {
      ...googleRenderer,
      sidebarApps: [
        ...googleRenderer.sidebarApps!,
        {
          id: 'other',
          label: 'Other',
          icon: () => null,
          order: 100,
          render: () => <Input aria-label="Other app state" defaultValue="initial" />,
        },
      ],
    },
  ])
  const workspace = openTab(openTab(emptyWorkspace(), otherKey), mailKey)
  store.set(shellWorkspaceAtom, showMail ? workspace : selectEntry(workspace, otherKey))
  render(
    <Provider store={store}>
      <MailTabs />
    </Provider>,
  )
  return {
    store,
    show: (key: string) => act(() => store.set(shellWorkspaceAtom, (ws) => selectEntry(ws, key))),
  }
}

test('shell switch and back retains real Mail list, selection and scroll without refetching', async () => {
  const { show } = mountMailTabs()
  const list = await screen.findByRole('list', { name: 'Inbox' })
  fireEvent.click(within(list).getByText('Q2 budget'))
  await screen.findByRole('heading', { name: 'Q2 budget' })
  const frame = document.querySelector('iframe')!
  const listScroller = list.closest('[data-slot="scroll-area-viewport"]') as HTMLElement
  const readerScroller = frame.closest('.overflow-y-auto') as HTMLElement
  expect(frame).not.toBeNull()
  expect(listScroller).not.toBeNull()
  expect(readerScroller).not.toBeNull()
  listScroller.scrollTop = 180
  readerScroller.scrollTop = 275
  const listCalls = searchMock.mock.calls.length
  const threadCalls = threadMock.mock.calls.length

  show(otherKey)
  await screen.findByRole('textbox', { name: 'Other app state' })
  expect(list.isConnected).toBe(true)
  expect(frame.isConnected).toBe(true)
  expect(list.closest('[inert]')).not.toBeNull()
  expect(screen.queryByRole('heading', { name: 'Q2 budget' })).toBeNull()

  show(mailKey)
  expect(await screen.findByRole('list', { name: 'Inbox' })).toBe(list)
  expect(screen.getByRole('heading', { name: 'Q2 budget' })).toBeInTheDocument()
  expect(document.querySelector('iframe')).toBe(frame)
  expect(listScroller.scrollTop).toBe(180)
  expect(readerScroller.scrollTop).toBe(275)
  expect(searchMock).toHaveBeenCalledTimes(listCalls)
  expect(threadMock).toHaveBeenCalledTimes(threadCalls)
})

test.each([
  ['mailbox', 'Mailbox: Inbox'],
  ['Gmail category', 'Inbox tab: All tabs'],
  ['account', 'Google account ada@syv.ai'],
] as const)('parked Mail closes its %s menu', async (_name, triggerName) => {
  const user = userEvent.setup()
  const { show } = mountMailTabs()
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: triggerName }))
  expect(await screen.findByRole('menu')).toBeInTheDocument()

  show(otherKey)
  const foreground = await screen.findByRole('textbox', { name: 'Other app state' })
  expect(screen.queryByRole('menu')).toBeNull()
  await user.click(foreground)
  await user.type(foreground, ' typed')
  expect(foreground).toHaveValue('initial typed')

  show(mailKey)
  expect(await screen.findByRole('list', { name: 'Inbox' })).toBeInTheDocument()
  expect(screen.queryByRole('menu')).toBeNull()
})

test('parked Mail hides an open tooltip', async () => {
  const user = userEvent.setup()
  const { show } = mountMailTabs()
  await screen.findByRole('list', { name: 'Inbox' })
  await user.hover(screen.getByRole('button', { name: 'Refresh mail' }))
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Refresh')

  show(otherKey)
  await screen.findByRole('textbox', { name: 'Other app state' })
  expect(screen.queryByRole('tooltip')).toBeNull()
})

test('parked Mail closes its More actions menu without losing the open thread', async () => {
  const user = userEvent.setup()
  const { show } = mountMailTabs()
  const list = await screen.findByRole('list', { name: 'Inbox' })
  await user.click(within(list).getByText('Q2 budget'))
  await screen.findByRole('heading', { name: 'Q2 budget' })
  await user.click(screen.getByRole('button', { name: 'More actions' }))
  expect(await screen.findByRole('menu')).toBeInTheDocument()

  show(otherKey)
  expect(screen.queryByRole('menu')).toBeNull()
  const foreground = await screen.findByRole('textbox', { name: 'Other app state' })
  await user.click(foreground)
  await user.type(foreground, ' typed')
  expect(foreground).toHaveValue('initial typed')

  show(mailKey)
  expect(screen.getByRole('heading', { name: 'Q2 budget' })).toBeInTheDocument()
  expect(screen.queryByRole('menu')).toBeNull()
})

test('switching Google accounts releases the previous account’s Mail state', async () => {
  const user = userEvent.setup()
  mountMailTabs()
  const list = await screen.findByRole('list', { name: 'Inbox' })
  await user.click(within(list).getByText('Q2 budget'))
  await screen.findByRole('heading', { name: 'Q2 budget' })
  const frame = document.querySelector('iframe')!
  searchMock.mockResolvedValue(page([summary({ id: 'second', subject: 'Second account mail' })]))

  await user.click(screen.getByRole('button', { name: 'Google account ada@syv.ai' }))
  await user.click(await screen.findByRole('menuitem', { name: 'ada@home.test' }))
  await screen.findByText('Second account mail', { selector: 'p' })
  expect(list.isConnected).toBe(false)
  expect(frame.isConnected).toBe(false)
  expect(screen.queryByRole('heading', { name: 'Q2 budget' })).toBeNull()
  expect(screen.getByText('Pick a thread to read it')).toBeInTheDocument()
})

test('an open inline reply prevents switching accounts until its save succeeds and it closes', async () => {
  const user = userEvent.setup()
  mountMailTabs()
  const list = await screen.findByRole('list', { name: 'Inbox' })
  await user.click(within(list).getByText('Q2 budget'))
  await screen.findByRole('heading', { name: 'Q2 budget' })
  await user.click(screen.getByRole('button', { name: 'Reply all' }))

  const composer = await screen.findByRole('region', { name: 'Compose mail' })
  const subject = within(composer).getByRole('textbox', { name: 'Subject' })
  await user.clear(subject)
  await user.type(subject, 'Private reply text')
  saveDraftMock.mockRejectedValueOnce(new Error('offline'))
  fireEvent.blur(subject)
  await screen.findByText('Not saved')
  await user.click(screen.getByRole('button', { name: 'Google account ada@syv.ai' }))
  const otherAccount = await screen.findByRole('menuitem', { name: 'ada@home.test' })
  expect(otherAccount).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByText('Close your reply before switching accounts.')).toBeInTheDocument()
  await user.click(otherAccount)
  expect(useAccountMock).not.toHaveBeenCalled()
  expect(saveDraftAccounts).not.toContain('b')
  expect(
    saveDraftMock.mock.calls.some(
      ([params]) => (params as { mail: { subject: string } }).mail.subject === 'Private reply text',
    ),
  ).toBe(true)
  expect(composer.isConnected).toBe(true)
  expect(subject).toHaveValue('Private reply text')

  saveDraftMock.mockResolvedValue({ id: 'draft-1' })
  fireEvent.blur(subject)
  await screen.findByText('Saved')
  fireEvent.keyDown(composer, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Compose mail' })).toBeNull())

  searchMock.mockResolvedValue(page([summary({ id: 'second', subject: 'Second account mail' })]))
  await user.click(screen.getByRole('button', { name: 'Google account ada@syv.ai' }))
  await user.click(await screen.findByRole('menuitem', { name: 'ada@home.test' }))
  await screen.findByText('Second account mail', { selector: 'p' })
  expect(useAccountMock).toHaveBeenCalledWith(expect.objectContaining({ sub: 'b' }))
  expect(screen.getByText('Pick a thread to read it')).toBeInTheDocument()
})

test('Mail first mounts when displayed, close and reopen starts fresh, other apps still unmount', async () => {
  const { store, show } = mountMailTabs(false)
  const other = screen.getByRole('textbox', { name: 'Other app state' })
  fireEvent.change(other, { target: { value: 'temporary' } })
  expect(searchMock).not.toHaveBeenCalled()
  show(mailKey)
  const list = await screen.findByRole('list', { name: 'Inbox' })
  expect(other.isConnected).toBe(false)
  show(otherKey)
  expect(screen.getByRole('textbox', { name: 'Other app state' })).toHaveValue('initial')
  act(() => store.set(shellWorkspaceAtom, (ws) => closeTab(ws, mailKey)))
  expect(list.isConnected).toBe(false)
  const calls = searchMock.mock.calls.length
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(ws, mailKey)))
  expect(await screen.findByRole('list', { name: 'Inbox' })).not.toBe(list)
  expect(searchMock).toHaveBeenCalledTimes(calls + 1)
  expect(screen.getByText('Pick a thread to read it')).toBeInTheDocument()
})

test('parked Mail is disposed when its plugin is removed or its vault changes', async () => {
  const { store, show } = mountMailTabs()
  const list = await screen.findByRole('list', { name: 'Inbox' })
  show(otherKey)
  const plugins = store.get(installedPluginsAtom)
  act(() => store.set(installedPluginsAtom, []))
  expect(list.isConnected).toBe(false)
  act(() => store.set(installedPluginsAtom, plugins))
  expect(document.querySelector('[role="list"][aria-label="Inbox"]')).toBeNull()
  show(mailKey)
  const nextList = await screen.findByRole('list', { name: 'Inbox' })
  show(otherKey)
  act(() => store.set(activeRemoteAtom, 'syv-ai/another-vault'))
  expect(nextList.isConnected).toBe(false)
})
