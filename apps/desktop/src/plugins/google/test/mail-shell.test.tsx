/**
 * The app-shell-4 mail view, rendered on its own against faked Google
 * capabilities: what it asks Gmail for, what it shows, and that HTML bodies
 * still go through the sandboxed frame.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { atom, getDefaultStore } from 'jotai'
import { activeRemoteAtom, saveBeforeClosing, sessionAtom } from '@/plugin-api'
import { MailShell } from '../renderer/mail/mail-shell'
import { mailCatchUpByVaultAtom } from '../renderer/mail/mail-catch-up'
import { refreshGoogleAtom } from '../renderer/account'
import { ConnectionsSection } from '../renderer/connections-section'
import { resetMailImagesForTests } from '../renderer/mail-images'
import { resetMailFramesForTests } from '../renderer/mail-frames'

const searchMock = vi.fn()
const threadMock = vi.fn()
const draftsMock = vi.fn()
const saveDraftMock = vi.fn()
const draftBodyMock = vi.fn()
const markReadMock = vi.fn()
const starMock = vi.fn()
const mailMarkersMock = vi.fn()
const setMailMarkerMock = vi.fn()
const archiveMock = vi.fn()
const trashMock = vi.fn()
const useAccountMock = vi.fn()
const disconnectVaultMock = vi.fn()
const removeAccountMock = vi.fn()
const setClientMock = vi.fn()
let accountSub = 'a'
const toastMock = vi.fn()
const openExternal = vi.fn()
const { agentStartMock, agentStopMock, agentServiceMock, tasksAvailabilityMock } = vi.hoisted(
  () => ({
    agentStartMock: vi.fn(),
    agentStopMock: vi.fn(),
    agentServiceMock: vi.fn(),
    tasksAvailabilityMock: vi.fn(),
  }),
)

vi.mock('@/plugin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugin-api')>()
  return {
    ...actual,
    useAgentService: () => agentServiceMock(),
    useCapabilityAvailability: () => tasksAvailabilityMock(),
  }
})

const google: Record<string, (params: unknown) => unknown> = {
  status: () => ({
    account:
      accountSub === '' ? null : { email: accountSub === 'a' ? 'ada@syv.ai' : 'ada@home.test' },
    currentSub: accountSub || null,
    missingScopes: [],
    needsReconnect: false,
  }),
  allAccounts: () => ({
    accounts: [
      { sub: 'a', email: 'ada@syv.ai' },
      { sub: 'b', email: 'ada@home.test' },
    ],
    current: accountSub,
  }),
  useAccount: (p) => useAccountMock(p),
  disconnectVault: () => disconnectVaultMock(),
  removeAccount: (p) => removeAccountMock(p),
  client: () => ({ id: 'holi.apps.googleusercontent.com', source: 'shipped' }),
  setClient: (p) => setClientMock(p),
  search: async (p) => {
    const answer = await searchMock(p)
    const request = (p as { uiList?: { loadedIds: string[]; refresh?: boolean } }).uiList
    if (!request || answer.uiList) return answer
    return {
      ...answer,
      uiList: {
        mode: request.refresh ? 'coverage' : 'page',
        revalidatedIds: request.refresh ? request.loadedIds : [],
        removedIds: request.refresh
          ? request.loadedIds.filter(
              (id) => !answer.threads.some((thread: { id: string }) => thread.id === id),
            )
          : [],
      },
    }
  },
  thread: (p) => threadMock(p),
  drafts: () => draftsMock(),
  saveDraft: (p) => saveDraftMock(p),
  draftBody: (p) => draftBodyMock(p),
  discardDraft: () => undefined,
  send: () => ({ id: 'sent' }),
  mailCounts: () => ({ unread: 2, total: 40 }),
  categoryCounts: () => ({}),
  contacts: () => [],
  sendAs: () => ['ada@syv.ai'],
  meeting: () => null,
  'mark-read': (p) => markReadMock(p),
  star: (p) => starMock(p),
  mailMarkerAnnotations: (p) => mailMarkersMock(p),
  mailMarkerPreferences: () => ({ enabledOrder: ['yellow-star'] }),
  setMailMarkerPreferences: () => ({ ok: true }),
  setMailMarker: (p) => setMailMarkerMock(p),
  archive: (p) => archiveMock(p),
  trash: (p) => trashMock(p),
  imageSenders: () => [],
  allowImagesFrom: () => ({ ok: true }),
  forgetImageSenders: () => ({ ok: true }),
}

vi.mock('sonner', async (original) => {
  const sonner = await original<typeof import('sonner')>()
  return {
    ...sonner,
    toast: Object.assign((...args: Parameters<typeof sonner.toast>) => {
      toastMock(...args)
      return sonner.toast(...args)
    }, sonner.toast),
  }
})

vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: {
      run: {
        mutate: async ({
          remote,
          name,
          paramsJson,
        }: {
          remote: string
          name: string
          paramsJson?: string
        }) => {
          const params = paramsJson === undefined ? undefined : JSON.parse(paramsJson)
          if (name === 'agent.stop') return agentStopMock(remote, params)
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
  return {
    threads,
    nextPageToken,
    syncedAt: new Date().toISOString(),
    uiList: {
      mode: 'page',
      cursor: { version: 1, owner: accountSub, key: 'inbox', historyId: '100' },
      removedIds: [],
      revalidatedIds: [],
    },
  }
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
  searchMock.mockReset().mockResolvedValue(page([summary()]))
  threadMock.mockReset().mockResolvedValue(thread)
  draftsMock.mockReset().mockResolvedValue([])
  saveDraftMock.mockReset().mockResolvedValue({ id: 'd-new' })
  draftBodyMock.mockReset().mockResolvedValue({
    draftId: 'd-new',
    threadId: null,
    to: [],
    cc: [],
    subject: '',
    markdown: '',
    html: null,
    foreign: false,
  })
  markReadMock.mockReset().mockResolvedValue({ ok: true })
  starMock.mockReset().mockResolvedValue({ ok: true })
  mailMarkersMock.mockReset().mockResolvedValue({})
  setMailMarkerMock.mockReset().mockResolvedValue({ ok: true })
  archiveMock.mockReset().mockResolvedValue({ ok: true })
  trashMock.mockReset().mockResolvedValue({ ok: true })
  useAccountMock.mockReset().mockImplementation(async ({ sub }: { sub: string }) => {
    accountSub = sub
    return { ok: true }
  })
  disconnectVaultMock.mockReset().mockImplementation(async () => {
    accountSub = ''
    return { ok: true }
  })
  removeAccountMock.mockReset().mockResolvedValue({ ok: true })
  setClientMock.mockReset().mockResolvedValue({ ok: true })
  accountSub = 'a'
  toastMock.mockReset()
  openExternal.mockReset()
  agentStopMock.mockReset().mockResolvedValue({ ok: true })
  agentStartMock.mockReset().mockResolvedValue({ ok: true })
  agentServiceMock.mockReset().mockReturnValue({
    start: agentStartMock,
    show: vi.fn().mockResolvedValue({ ok: true }),
    ask: vi.fn(),
    targets: atom({ default: 'new' }),
  })
  tasksAvailabilityMock.mockReset().mockReturnValue('available')
  getDefaultStore().set(mailCatchUpByVaultAtom, new Map())
  getDefaultStore().set(sessionAtom, { login: 'ada' } as never)
  getDefaultStore().set(activeRemoteAtom, 'syv-ai/vault')
  resetMailImagesForTests()
  resetMailFramesForTests()
  // @ts-expect-error: the preload bridge is not typed onto window in tests.
  window.holi = { openExternal }
})
afterEach(() => {
  // @ts-expect-error: as above.
  delete window.holi
})

test('retained mail saves before Settings changes the Google account and keeps the draft on failure', async () => {
  let finishLink!: () => void
  const user = userEvent.setup()
  render(
    <>
      <MailShell />
      <ConnectionsSection />
    </>,
  )
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Compose new email' }))
  const editor = await screen.findByRole('textbox', { name: 'Subject' })
  await user.type(editor, 'still here')

  saveDraftMock.mockRejectedValueOnce(new Error('offline'))
  await user.click(await screen.findByRole('button', { name: 'Disconnect this vault' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(/draft.*not changed/i)
  expect(disconnectVaultMock).not.toHaveBeenCalled()
  expect(accountSub).toBe('a')
  expect(editor).toHaveValue('still here')

  disconnectVaultMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLink = () => {
          accountSub = ''
          resolve({ ok: true })
        }
      }),
  )
  await user.click(screen.getByRole('button', { name: 'Disconnect this vault' }))
  await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(2))
  expect(saveDraftMock.mock.calls.at(-1)![0]).toMatchObject({ mail: { subject: 'still here' } })
  await waitFor(() => expect(editor).toBeDisabled())
  finishLink()
  await waitFor(() => expect(disconnectVaultMock).toHaveBeenCalledTimes(1))
  expect(accountSub).toBe('')
  expect(saveDraftMock.mock.calls.at(-1)![0]).toMatchObject({ mail: { subject: 'still here' } })
  expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument()
})

test('lists the inbox from Gmail with its sender, subject, tab and labels', async () => {
  render(<MailShell />)

  const list = await screen.findByRole('list', { name: 'Inbox' })
  const row = within(list).getByRole('listitem')
  expect(within(row).getByText('Jane Doe')).toBeInTheDocument()
  expect(within(row).getByText('Q2 budget')).toBeInTheDocument()
  expect(within(row).getByText('Updates')).toBeInTheDocument()
  expect(within(row).getByText('Finance')).toBeInTheDocument()
  expect(within(row).getByRole('img', { name: 'Unread' })).toBeInTheDocument()
  expect(searchMock).toHaveBeenCalled()
  expect(searchMock.mock.lastCall?.[0]).not.toHaveProperty('query')
  expect(searchMock.mock.lastCall?.[0]).not.toHaveProperty('mailbox')
  expect(searchMock.mock.lastCall?.[0]).not.toHaveProperty('unread')
  expect(searchMock.mock.lastCall?.[0]).not.toHaveProperty('category')
})

test('readable mail metadata uses opaque semantic colors for rows, drafts, and attachments', async () => {
  searchMock.mockResolvedValue(
    page([
      summary({ id: 'unread', unread: true, category: 'primary', labels: [] }),
      summary({
        id: 'read',
        unread: false,
        subject: 'Filed report',
        category: 'primary',
        labels: [],
      }),
    ]),
  )
  draftsMock.mockResolvedValue([
    {
      draftId: 'd1',
      threadId: null,
      to: [{ name: 'Grace Hopper', email: 'grace@example.com' }],
      subject: 'Compiler notes',
      snippet: 'Still working on the draft',
      date: '2026-08-04T09:00:00.000Z',
    },
  ])
  const user = userEvent.setup()
  render(<MailShell />)

  const list = await screen.findByRole('list', { name: 'Inbox' })
  const rows = within(list).getAllByRole('listitem')
  expect(rows).toHaveLength(2)
  const unreadRow = rows.find((row) => within(row).queryByText('Q2 budget'))!
  const readRow = rows.find((row) => within(row).queryByText('Filed report'))!
  for (const row of rows) {
    expect(
      [...row.querySelectorAll('*')].some((node) =>
        [...node.classList].some((name) => /^opacity-\d+$/.test(name)),
      ),
    ).toBe(false)
    expect(row.querySelector('[style*="opacity"]')).toBeNull()
  }
  const unread = within(unreadRow).getByText('Jane Doe')
  const unreadDate = unreadRow.querySelector('.tabular-nums')
  expect(unread).toHaveClass('text-foreground')
  expect(unreadDate).toHaveClass('text-muted-foreground')
  expect(within(unreadRow).getByText('Q2 budget')).toHaveClass('text-foreground')
  expect(within(unreadRow).getByText('Numbers attached')).toHaveClass('text-muted-foreground')
  expect(within(readRow).getByText('Jane Doe')).toHaveClass('text-foreground')
  expect(within(readRow).getByText('Filed report')).toHaveClass('text-foreground')
  expect(unreadRow.className).toContain('hover:bg-accent/60')
  await user.hover(unreadRow)
  expect(unreadRow.className).toContain('hover:bg-accent/60')

  await user.click(screen.getByRole('button', { name: 'Mailbox: Inbox' }))
  await user.click(await screen.findByRole('menuitemradio', { name: 'Drafts' }))
  const draftList = await screen.findByRole('list', { name: 'Drafts' })
  const draftRow = within(draftList).getByRole('listitem')
  expect(within(draftRow).getByText('Grace Hopper')).toHaveClass('text-foreground')
  expect(draftRow.querySelector('.tabular-nums')).toHaveClass('text-muted-foreground')
  expect(within(draftRow).getByText('Compiler notes')).toHaveClass('text-foreground')
  expect(within(draftRow).getByText('Still working on the draft')).toHaveClass(
    'text-muted-foreground',
  )
  expect(
    [...draftRow.querySelectorAll('*')].some((node) =>
      [...node.classList].some((name) => /^opacity-\d+$/.test(name)),
    ),
  ).toBe(false)
  expect(draftRow.querySelector('[style*="opacity"]')).toBeNull()

  await user.click(screen.getByRole('button', { name: 'Mailbox: Drafts' }))
  await user.click(await screen.findByRole('menuitemradio', { name: 'Inbox' }))
  await user.click(await screen.findByText('Q2 budget', { selector: 'p' }))
  const attachment = await screen.findByRole('button', { name: /^q2\.xlsx/ })
  const size = within(attachment).getByText('(20 KB)')
  expect(size).toHaveClass('text-muted-foreground')
  expect([...size.parentElement!.classList].some((name) => /^opacity-\d+$/.test(name))).toBe(false)
})

test('opens a thread: marks it read, renders HTML in the sandboxed frame', async () => {
  const user = userEvent.setup()
  render(<MailShell />)

  await user.click(await screen.findByText('Q2 budget', { selector: 'p' }))

  expect(threadMock).toHaveBeenCalledWith({ id: 't1' })
  expect(markReadMock).toHaveBeenCalledWith({ id: 't1', unread: false })
  expect(await screen.findByRole('heading', { name: 'Q2 budget' })).toBeInTheDocument()

  // Only the last message is open; its HTML lives in a frame, not the app.
  const frame = await waitFor(() => {
    const found = document.querySelector('iframe')
    expect(found).not.toBeNull()
    return found!
  })
  expect(frame.getAttribute('sandbox')).toBe('allow-same-origin')
  await waitFor(() => expect(frame.contentDocument?.body.textContent).toContain('See the sheet'))
  expect(frame.contentDocument?.querySelector('script')).toBeNull()
  expect(document.body.textContent).not.toContain('alert(1)')

  // The earlier message is collapsed to its first line and owns no attachments.
  const collapsedMessage = screen.getByRole('button', { name: /Expand message 1 of 2/ })
  expect(collapsedMessage).toBeInTheDocument()
  expect(
    within(collapsedMessage.closest('article')!).queryByRole('button', { name: /^q2\.xlsx/ }),
  ).toBeNull()

  // This message's attachment comes before its HTML body and opens the thread in Gmail.
  const expandedMessage = frame.closest('article')!
  const attachment = within(expandedMessage).getByRole('button', { name: /^q2\.xlsx/ })
  expect(attachment.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await user.click(attachment)
  expect(openExternal).toHaveBeenCalledWith('https://mail.google.com/x')
})

test('the Unread tab asks Gmail for unread threads only', async () => {
  const user = userEvent.setup()
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })

  await user.click(screen.getByRole('tab', { name: 'Unread' }))

  await waitFor(() =>
    expect(searchMock).toHaveBeenLastCalledWith(expect.objectContaining({ unread: true })),
  )
})

test('search sends Gmail grammar on Enter and escapes the folder', async () => {
  const user = userEvent.setup()
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })

  await user.click(screen.getByRole('button', { name: 'Mailbox: Inbox' }))
  await user.click(await screen.findByRole('menuitemradio', { name: 'Sent' }))
  await waitFor(() =>
    expect(searchMock).toHaveBeenLastCalledWith(expect.objectContaining({ mailbox: 'sent' })),
  )

  await user.type(screen.getByRole('textbox', { name: 'Search mail' }), 'from:jane{Enter}')
  await waitFor(() =>
    expect(searchMock).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'from:jane' })),
  )
  expect(searchMock.mock.lastCall?.[0]).not.toHaveProperty('mailbox')
})

test('starred is one atomic navigation from Inbox and clears unread', async () => {
  const user = userEvent.setup()
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('tab', { name: 'Unread' }))
  await waitFor(() =>
    expect(searchMock).toHaveBeenLastCalledWith(expect.objectContaining({ unread: true })),
  )
  await user.click(screen.getByRole('button', { name: 'Compose new email' }))
  await screen.findByRole('region', { name: 'Compose mail' })

  await user.click(screen.getByRole('tab', { name: 'Starred' }))

  await waitFor(() =>
    expect(searchMock).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'is:starred' })),
  )
  expect(searchMock.mock.lastCall?.[0]).not.toHaveProperty('unread')
  expect(searchMock.mock.lastCall?.[0]).not.toHaveProperty('category')
  expect(screen.getByRole('tab', { name: 'Starred' })).toHaveAttribute('data-state', 'active')
})

test('archive takes the thread out at once and offers Undo', async () => {
  const user = userEvent.setup()
  render(<MailShell />)
  await user.click(await screen.findByText('Q2 budget', { selector: 'p' }))

  await user.click(await screen.findByRole('button', { name: 'Archive thread' }))

  expect(archiveMock).toHaveBeenCalledWith({ id: 't1' })
  await waitFor(() => expect(screen.queryByText('Q2 budget', { selector: 'p' })).toBeNull())
  await waitFor(() =>
    expect(toastMock).toHaveBeenCalledWith(
      'Thread archived',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
    ),
  )
})

test('a refused primary marker reconciles the star and says why', async () => {
  const user = userEvent.setup()
  setMailMarkerMock.mockRejectedValue(new Error('Insufficient permission'))
  render(<MailShell />)
  await user.click(await screen.findByText('Q2 budget', { selector: 'p' }))

  const primary = within(screen.getByRole('toolbar', { name: 'Thread actions' })).getByRole(
    'button',
    {
      name: 'Star thread',
    },
  )
  await user.click(primary)

  expect(await screen.findByRole('alert')).toHaveTextContent(/Reconnect Google/)
  await waitFor(() => expect(primary).toHaveAttribute('aria-pressed', 'true'))
})

test('reader Retry settles a failed marker reconciliation', async () => {
  const user = userEvent.setup()
  render(<MailShell />)
  await user.click(await screen.findByText('Q2 budget', { selector: 'p' }))
  await waitFor(() => expect(mailMarkersMock).toHaveBeenCalled())
  mailMarkersMock
    .mockRejectedValueOnce(new Error('temporary annotation failure'))
    .mockResolvedValueOnce({ t1: 'yellow-star' })
  await user.click(
    within(await screen.findByRole('toolbar', { name: 'Thread actions' })).getByRole('button', {
      name: 'Star thread',
    }),
  )

  const readerHeader = screen.getByRole('heading', { name: 'Q2 budget' }).closest('header')!
  await user.click(within(readerHeader).getByRole('button', { name: 'Retry marker' }))

  expect((await screen.findAllByLabelText('Yellow star')).length).toBeGreaterThan(0)
  await waitFor(() => expect(mailMarkersMock.mock.calls.length).toBeGreaterThanOrEqual(3))
})

test('reader preserves a Gmail star when its personal marker is absent', async () => {
  const user = userEvent.setup()
  searchMock.mockImplementation(async ({ query }: { query?: string } = {}) =>
    page([summary({ starred: query === 'is:starred' || query === undefined })]),
  )
  setMailMarkerMock.mockRejectedValue(new Error('removal refused'))
  render(<MailShell />)
  await user.click(await screen.findByText('Q2 budget', { selector: 'p' }))
  const toolbar = await screen.findByRole('toolbar', { name: 'Thread actions' })
  await user.click(within(toolbar).getByRole('button', { name: 'Unstar thread' }))

  expect(within(toolbar).getByRole('button', { name: 'Unstar thread' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(mailMarkersMock).toHaveBeenCalled()
})

test('drafts come from Gmail and say so when there are none', async () => {
  const user = userEvent.setup()
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })

  await user.click(screen.getByRole('button', { name: 'Mailbox: Inbox' }))
  await user.click(await screen.findByRole('menuitemradio', { name: 'Drafts' }))

  expect(await screen.findByText('No drafts')).toBeInTheDocument()
  expect(draftsMock).toHaveBeenCalled()
})

test('a failed load offers Try again, a disconnected one Connections', async () => {
  const user = userEvent.setup()
  searchMock.mockRejectedValueOnce(new Error('Gmail is down'))
  render(<MailShell />)

  expect(await screen.findByText('Couldn’t load your mail')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByRole('list', { name: 'Inbox' })).toBeInTheDocument()

  searchMock.mockRejectedValueOnce(
    Object.assign(new Error('nope'), { data: { code: 'UNAUTHORIZED' } }),
  )
  await user.click(screen.getByRole('button', { name: 'Refresh mail' }))
  expect(await screen.findByText('Google isn’t connected')).toBeInTheDocument()
})

test('the account menu exposes only the current identity and Connections navigation', async () => {
  const user = userEvent.setup()
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })

  await user.click(await screen.findByRole('button', { name: 'Google account ada@syv.ai' }))

  expect(screen.getByRole('menuitem', { name: /connections/i })).toBeInTheDocument()
  expect(screen.queryByText('ada@home.test')).toBeNull()
  expect(screen.getByText('ada@syv.ai')).toBeInTheDocument()
  expect(useAccountMock).not.toHaveBeenCalled()
})

test('compose opens the existing composer inline in the reader', async () => {
  const user = userEvent.setup()
  render(<MailShell visible />)
  await screen.findByRole('list', { name: 'Inbox' })

  await user.click(screen.getByRole('button', { name: 'Compose new email' }))

  expect(await screen.findByText('New message')).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('a failed composition save blocks thread, folder, compose, and Connections navigation', async () => {
  const user = userEvent.setup()
  saveDraftMock.mockRejectedValue(new Error('offline'))
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Compose new email' }))
  const subject = await screen.findByRole('textbox', { name: 'Subject' })
  await user.type(subject, 'unsaved words')

  await user.click(screen.getByText('Q2 budget', { selector: 'p' }))
  await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent('Not saved'))
  expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('unsaved words')
  expect(threadMock).not.toHaveBeenCalled()

  await user.click(screen.getByRole('button', { name: 'Mailbox: Inbox' }))
  await user.click(await screen.findByRole('menuitemradio', { name: 'Sent' }))
  expect(screen.getByRole('button', { name: 'Mailbox: Inbox' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('unsaved words')

  await user.click(screen.getByRole('button', { name: 'Compose new email' }))
  expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('unsaved words')

  await user.click(screen.getByRole('button', { name: 'Google account ada@syv.ai' }))
  await user.click(await screen.findByRole('menuitem', { name: /connections/i }))
  expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('unsaved words')
})

test('the shell close flush rejects an offline inline composition and leaves it editable', async () => {
  const user = userEvent.setup()
  saveDraftMock.mockRejectedValue(new Error('offline'))
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Compose new email' }))
  const region = await screen.findByRole('region', { name: 'Compose mail' })
  await user.type(within(region).getByRole('textbox', { name: 'Subject' }), 'pending')

  let closed = false
  await expect(saveBeforeClosing(() => (closed = true), true)).rejects.toThrow('offline')
  expect(closed).toBe(false)
  expect(screen.getByRole('region', { name: 'Compose mail' })).toBeInTheDocument()
  expect(within(region).getByRole('textbox', { name: 'Subject' })).toHaveValue('pending')
})

test('Close restores the reader selection behind standalone Compose', async () => {
  const user = userEvent.setup()
  render(<MailShell />)
  await user.click(await screen.findByText('Q2 budget', { selector: 'p' }))
  expect(await screen.findByRole('heading', { name: 'Q2 budget' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Compose new email' }))
  const composeRegion = await screen.findByRole('region', { name: 'Compose mail' })
  await user.click(within(composeRegion).getByRole('button', { name: 'Close' }))

  await waitFor(() => expect(screen.queryByRole('region', { name: 'Compose mail' })).toBeNull())
  expect(screen.getByRole('heading', { name: 'Q2 budget' })).toBeInTheDocument()
})

test('Close waits for the latest draft save, then removes the composer and restores the reader', async () => {
  const user = userEvent.setup()
  const saves: Array<(value: { id: string }) => void> = []
  saveDraftMock.mockImplementation(() => new Promise((resolve) => saves.push(resolve)))
  render(<MailShell />)
  await user.click(await screen.findByText('Q2 budget', { selector: 'p' }))
  await screen.findByRole('heading', { name: 'Q2 budget' })
  await user.click(screen.getByRole('button', { name: 'Compose new email' }))
  const region = await screen.findByRole('region', { name: 'Compose mail' })
  const subject = within(region).getByRole('textbox', { name: 'Subject' })
  await user.type(subject, 'first')
  await new Promise((resolve) => setTimeout(resolve, 2100))
  await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(1))
  await user.type(subject, '-latest')
  await user.click(within(region).getByRole('button', { name: 'Close' }))
  expect(screen.getByRole('region', { name: 'Compose mail' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Q2 budget' })).toBeInTheDocument()

  saves[0]!({ id: 'd-new' })
  await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(2))
  expect(saveDraftMock.mock.calls[1]![0]).toMatchObject({ mail: { subject: 'first-latest' } })
  saves[1]!({ id: 'd-new' })
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Compose mail' })).toBeNull())
  expect(screen.getByRole('heading', { name: 'Q2 budget' })).toBeInTheDocument()
})

test('a late Close completion from an old vault cannot close a newer composition', async () => {
  const user = userEvent.setup()
  let finishSave: ((value: { id: string }) => void) | undefined
  saveDraftMock.mockImplementation(() => new Promise((resolve) => (finishSave = resolve)))
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Compose new email' }))
  const oldRegion = await screen.findByRole('region', { name: 'Compose mail' })
  await user.type(within(oldRegion).getByRole('textbox', { name: 'Subject' }), 'old draft')
  await user.click(within(oldRegion).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(1))

  getDefaultStore().set(activeRemoteAtom, 'syv-ai/other-vault')
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Compose mail' })).toBeNull())
  await user.click(screen.getByRole('button', { name: 'Compose new email' }))
  const newRegion = await screen.findByRole('region', { name: 'Compose mail' })
  await user.type(within(newRegion).getByRole('textbox', { name: 'Subject' }), 'new draft')
  finishSave?.({ id: 'd-old' })

  expect(await screen.findByRole('region', { name: 'Compose mail' })).toBeInTheDocument()
  expect(within(newRegion).getByRole('textbox', { name: 'Subject' })).toHaveValue('new draft')
})

test('a failed Close keeps editing gated for the next navigation attempt', async () => {
  const user = userEvent.setup()
  saveDraftMock.mockRejectedValue(new Error('offline'))
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Compose new email' }))
  const region = await screen.findByRole('region', { name: 'Compose mail' })
  const subject = within(region).getByRole('textbox', { name: 'Subject' })
  await user.type(subject, 'unsaved subject')
  await user.click(within(region).getByRole('button', { name: 'Close' }))
  await waitFor(() =>
    expect(within(region).getByTestId('save-state')).toHaveTextContent('Not saved'),
  )
  expect(screen.getByRole('region', { name: 'Compose mail' })).toBeInTheDocument()
  expect(within(region).getByRole('textbox', { name: 'Subject' })).toHaveValue('unsaved subject')
  expect(within(region).getByRole('textbox', { name: 'Message' })).toHaveAttribute(
    'contenteditable',
    'true',
  )

  await user.type(within(region).getByRole('textbox', { name: 'Subject' }), ' again')
  await user.click(screen.getByText('Q2 budget', { selector: 'p' }))
  await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('region', { name: 'Compose mail' })).toBeInTheDocument()
  expect(within(region).getByRole('textbox', { name: 'Subject' })).toHaveValue(
    'unsaved subject again',
  )
  expect(within(region).getByRole('textbox', { name: 'Message' })).toHaveAttribute(
    'contenteditable',
    'true',
  )
  expect(threadMock).not.toHaveBeenCalled()
})

test.each(['reply', 'forward'] as const)(
  '%s uses the shared save-before-replacement gate',
  async (mode) => {
    const user = userEvent.setup()
    saveDraftMock.mockRejectedValue(new Error('offline'))
    render(<MailShell />)
    await user.click(await screen.findByText('Q2 budget', { selector: 'p' }))
    if (mode === 'reply') {
      await user.click(await screen.findByRole('button', { name: 'Reply all' }))
    } else {
      await user.click(screen.getByRole('button', { name: 'More actions' }))
      await user.click(await screen.findByRole('menuitem', { name: 'Forward' }))
    }
    const subject = await screen.findByRole('textbox', { name: 'Subject' })
    await user.type(subject, 'edited')
    await user.click(screen.getByRole('button', { name: 'Compose new email' }))

    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent('Not saved'))
    expect((screen.getByRole('textbox', { name: 'Subject' }) as HTMLInputElement).value).toContain(
      'edited',
    )
    expect(screen.getByRole('heading', { name: 'Q2 budget' })).toBeInTheDocument()
  },
)

test('a deferred Continue draft is ignored after the selected thread changes', async () => {
  const user = userEvent.setup()
  let finishDrafts: ((value: unknown[]) => void) | undefined
  searchMock.mockResolvedValue(
    page([summary({ hasDraft: true }), summary({ id: 't2', subject: 'Other' })]),
  )
  draftsMock.mockImplementation(() => new Promise((resolve) => (finishDrafts = resolve)))
  render(<MailShell />)
  await user.click(await screen.findByText('Q2 budget', { selector: 'p' }))
  await user.click(screen.getByRole('button', { name: 'More actions' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Continue your draft' }))
  await user.click(screen.getByText('Other', { selector: 'p' }))
  finishDrafts?.([
    { draftId: 'd-late', threadId: 't1', date: '2026-08-04', to: [], subject: 'Late draft' },
  ])

  await screen.findByRole('heading', { name: 'Q2 budget' })
  expect(threadMock).toHaveBeenCalledWith({ id: 't2' })
  expect(screen.queryByText('New message')).toBeNull()
  expect(screen.queryByRole('textbox', { name: 'Subject' })).toBeNull()
})

test('a deferred Continue draft is ignored after a vault switch', async () => {
  const user = userEvent.setup()
  let finishDrafts: ((value: unknown[]) => void) | undefined
  searchMock.mockResolvedValue(page([summary({ hasDraft: true })]))
  draftsMock.mockImplementation(() => new Promise((resolve) => (finishDrafts = resolve)))
  render(<MailShell />)
  await user.click(await screen.findByText('Q2 budget', { selector: 'p' }))
  await user.click(screen.getByRole('button', { name: 'More actions' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Continue your draft' }))

  getDefaultStore().set(activeRemoteAtom, 'syv-ai/other-vault')
  finishDrafts?.([
    { draftId: 'd-late', threadId: 't1', date: '2026-08-04', to: [], subject: 'Late draft' },
  ])
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(screen.queryByText('New message')).toBeNull()
  expect(screen.queryByRole('textbox', { name: 'Subject' })).toBeNull()
})

test('a departed sidebar does not navigate when its save completes', async () => {
  const user = userEvent.setup()
  let finishSave: ((value: { id: string }) => void) | undefined
  saveDraftMock.mockImplementation(() => new Promise((resolve) => (finishSave = resolve)))
  const view = render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Compose new email' }))
  await user.type(await screen.findByRole('textbox', { name: 'Subject' }), 'unfinished')
  await user.click(screen.getByText('Q2 budget', { selector: 'p' }))
  await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(1))
  view.unmount()
  finishSave?.({ id: 'd-new' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(threadMock).not.toHaveBeenCalled()
})

test('thread navigation waits for the latest content save', async () => {
  const user = userEvent.setup()
  let finishSave: ((value: { id: string }) => void) | undefined
  saveDraftMock.mockImplementation(() => new Promise((resolve) => (finishSave = resolve)))
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Compose new email' }))
  const subject = await screen.findByRole('textbox', { name: 'Subject' })
  await user.type(subject, 'first')
  await new Promise((resolve) => setTimeout(resolve, 2100))
  await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(1))
  await user.type(screen.getByRole('textbox', { name: 'Subject' }), '-latest')
  await user.click(screen.getByText('Q2 budget', { selector: 'p' }))
  expect(threadMock).not.toHaveBeenCalled()

  finishSave?.({ id: 'd-new' })
  await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(2))
  expect(saveDraftMock.mock.calls[1]![0]).toMatchObject({ mail: { subject: 'first-latest' } })
  finishSave?.({ id: 'd-new' })
  await waitFor(() => expect(threadMock).toHaveBeenCalledWith({ id: 't1' }))
  expect(screen.queryByRole('textbox', { name: 'Subject' })).toBeNull()
})

test.each([
  { key: '{Enter}', label: 'Enter' },
  { key: ' ', label: 'Space' },
])(
  'Retry marker keyboard $label retries annotation without activating its mail row',
  async ({ key }) => {
    searchMock.mockResolvedValue(page([summary({ id: 'retry-thread', starred: true })]))
    mailMarkersMock
      .mockRejectedValueOnce(new Error('annotation read failed'))
      .mockResolvedValueOnce({ 'retry-thread': 'yellow-star' })
    const user = userEvent.setup()
    render(<MailShell />)
    const retry = await screen.findByRole('button', { name: 'Retry marker' })
    await waitFor(() => expect(mailMarkersMock).toHaveBeenCalledTimes(1))
    retry.focus()
    expect(retry).toHaveFocus()

    await user.keyboard(key)

    await waitFor(() => expect(mailMarkersMock).toHaveBeenCalledTimes(2))
    expect(mailMarkersMock.mock.calls[1]![0]).toMatchObject({
      ids: ['retry-thread'],
      expectedAccountSub: 'a',
    })
    expect(await screen.findByLabelText('Yellow star')).toBeInTheDocument()
    expect(threadMock).not.toHaveBeenCalled()
    expect(markReadMock).not.toHaveBeenCalled()
  },
)

test('the mail row itself still opens with keyboard activation', async () => {
  const user = userEvent.setup()
  render(<MailShell />)
  const row = await screen.findByRole('listitem')
  row.focus()
  expect(row).toHaveFocus()

  await user.keyboard('{Enter}')

  expect(await screen.findByRole('heading', { name: 'Q2 budget' })).toBeInTheDocument()
  expect(threadMock).toHaveBeenCalledWith({ id: 't1' })
  expect(markReadMock).toHaveBeenCalledWith({ id: 't1', unread: false })
})

test('renders all configured marker symbols in the app-shell list', async () => {
  searchMock.mockResolvedValue(
    page([
      summary({ id: 'yellow', subject: 'Yellow marker', starred: true }),
      summary({ id: 'red', subject: 'Red marker', starred: true }),
      summary({ id: 'blue', subject: 'Blue marker', starred: true }),
    ]),
  )
  mailMarkersMock.mockResolvedValue({
    yellow: 'yellow-star',
    red: 'red-star',
    blue: 'blue-question',
  })
  render(<MailShell />)

  for (const label of ['Yellow star', 'Red star', 'Blue question mark'])
    expect(await screen.findByLabelText(label)).toBeInTheDocument()
  await waitFor(() => expect(mailMarkersMock).toHaveBeenCalledTimes(1))
  expect(mailMarkersMock.mock.calls[0]![0]).toMatchObject({
    ids: ['blue', 'red', 'yellow'],
    expectedAccountSub: 'a',
  })
})

test('simultaneous Mail surfaces share one catch-up admission', async () => {
  const user = userEvent.setup()
  let finish!: (value: { ok: true }) => void
  agentStartMock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  render(
    <>
      <MailShell />
      <MailShell />
    </>,
  )
  await screen.findAllByRole('button', { name: 'Catch me up' })
  const buttons = screen.getAllByRole('button', { name: 'Catch me up' })
  await user.click(buttons[0]!)
  await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1))
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'Starting catch-up' })).toHaveLength(2),
  )
  await user.click(screen.getAllByRole('button', { name: 'Starting catch-up' })[1]!)
  expect(agentStartMock).toHaveBeenCalledTimes(1)
  finish({ ok: true })
})

test('catch-up admission survives Mail unmount while startup is pending', async () => {
  const user = userEvent.setup()
  let finish!: (value: { ok: true }) => void
  agentStartMock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  const first = render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Catch me up' }))
  await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1))
  first.unmount()

  render(<MailShell />)
  expect(await screen.findByRole('button', { name: 'Starting catch-up' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Starting catch-up' }))
  expect(agentStartMock).toHaveBeenCalledTimes(1)
  finish({ ok: true })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Catch me up' })).toBeEnabled())
})

test('catch-up uncertainty survives Mail remount and vault A-B-A for its origin', async () => {
  const user = userEvent.setup()
  const show = vi.fn().mockResolvedValue({ ok: true })
  agentServiceMock.mockReturnValue({
    start: agentStartMock,
    show,
    ask: vi.fn(),
    targets: atom({ default: 'new' }),
  })
  let finish!: (value: {
    ok: false
    cleanupUnconfirmed: true
    message: string
    sessionId: string
  }) => void
  agentStartMock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  const first = render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Catch me up' }))
  await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1))
  first.unmount()

  getDefaultStore().set(activeRemoteAtom, 'syv-ai/other')
  finish({
    ok: false,
    cleanupUnconfirmed: true,
    message: 'Cleanup unconfirmed: session may still be running.',
    sessionId: 'origin-survivor',
  })
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  expect(screen.queryByRole('alert')).toBeNull()

  getDefaultStore().set(activeRemoteAtom, 'syv-ai/vault')
  expect(await screen.findByRole('alert')).toHaveTextContent('Cleanup unconfirmed')
  expect(screen.getByRole('button', { name: 'Catch me up' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Open surviving session' }))
  expect(show).toHaveBeenCalledWith({ session: 'origin-survivor', live: true })
  expect(agentStartMock).toHaveBeenCalledTimes(1)
})

test('catch-up starts a read-only prompt for the signed-in login without opening mail', async () => {
  const user = userEvent.setup()
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Catch me up' }))

  await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1))
  const [{ name, prompt }] = agentStartMock.mock.calls[0]!
  expect(name).toBe('Mail catch-up')
  expect(prompt).toContain('signed-in GitHub login is ada')
  expect(prompt).toContain("holi google search 'in:inbox is:unread'")
  expect(prompt).toContain('holi google read <thread-id>')
  expect(prompt).toContain('holi tasks list --assignee ada --open --json')
  expect(prompt).toContain('priority and content')
  expect(prompt).toContain('Do not mark mail read')
  expect(threadMock).not.toHaveBeenCalled()
  expect(markReadMock).not.toHaveBeenCalled()
})

test('catch-up confirms disabled tasks and lets an unresolved lookup degrade honestly', async () => {
  const user = userEvent.setup()
  tasksAvailabilityMock.mockReturnValue('unavailable')
  const { rerender } = render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Catch me up' }))
  await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1))
  expect(agentStartMock.mock.calls[0]![0].prompt).toContain(
    'Tasks are unavailable in this vault. Say so',
  )

  agentStartMock.mockClear()
  tasksAvailabilityMock.mockReturnValue('unknown')
  rerender(<MailShell />)
  await user.click(screen.getByRole('button', { name: 'Catch me up' }))
  await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1))
  expect(agentStartMock.mock.calls[0]![0].prompt).toContain('Try reading tasks with')
  expect(agentStartMock.mock.calls[0]![0].prompt).not.toContain(
    'Tasks are unavailable in this vault',
  )
})

test('catch-up offers existing-session recovery and blocks another launch after uncertain cleanup', async () => {
  const user = userEvent.setup()
  const show = vi.fn().mockResolvedValue({ ok: true })
  agentServiceMock.mockReturnValue({
    start: agentStartMock,
    show,
    ask: vi.fn(),
    targets: atom({ default: 'new' }),
  })
  agentStartMock.mockResolvedValueOnce({
    ok: false,
    message: 'Cleanup unconfirmed: session may still be running.',
    cleanupUnconfirmed: true,
    sessionId: 'session-survivor',
  })
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Catch me up' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Cleanup unconfirmed')
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  const catchUp = screen.getByRole('button', { name: 'Catch me up' })
  expect(catchUp).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Open surviving session' }))
  expect(show).toHaveBeenCalledWith({ session: 'session-survivor', live: true })
  expect(agentStartMock).toHaveBeenCalledTimes(1)
})

test('catch-up admission survives Google account A-B-A while startup is pending', async () => {
  const user = userEvent.setup()
  let finish!: (value: { ok: false; message: string }) => void
  agentStartMock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Catch me up' }))
  await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1))

  for (const sub of ['b', 'a']) {
    accountSub = sub
    getDefaultStore().set(refreshGoogleAtom)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Starting catch-up' })).toBeDisabled(),
    )
  }
  await user.click(screen.getByRole('button', { name: 'Starting catch-up' }))
  expect(agentStartMock).toHaveBeenCalledTimes(1)
  getDefaultStore().set(activeRemoteAtom, 'syv-ai/other')
  getDefaultStore().set(activeRemoteAtom, 'syv-ai/vault')
  finish({ ok: false, message: 'stale startup result' })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Catch me up' })).toBeEnabled())
  expect(screen.queryByRole('alert')).toBeNull()
})

test('catch-up ignores a stale A-B-A completion', async () => {
  const user = userEvent.setup()
  let finish!: (value: { ok: false; message: string }) => void
  agentStartMock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Catch me up' }))
  await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1))

  getDefaultStore().set(activeRemoteAtom, 'syv-ai/other')
  getDefaultStore().set(activeRemoteAtom, 'syv-ai/vault')
  finish({ ok: false, message: 'stale launch error' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(screen.queryByRole('alert')).toBeNull()
})

test.each([
  { missing: 'login', message: /sign in to GitHub/i },
  { missing: 'vault', message: /no vault is open/i },
  { missing: 'agent', message: /no agent is running/i },
])('catch-up rejects missing $missing before starting', async ({ missing, message }) => {
  const user = userEvent.setup()
  if (missing === 'login') getDefaultStore().set(sessionAtom, null)
  if (missing === 'vault') getDefaultStore().set(activeRemoteAtom, null)
  if (missing === 'agent') agentServiceMock.mockReturnValue(null)
  render(<MailShell />)

  if (missing !== 'vault') {
    await screen.findByRole('list', { name: 'Inbox' })
    await user.click(screen.getByRole('button', { name: 'Catch me up' }))
  }
  expect(await screen.findByRole('alert')).toHaveTextContent(message)
  expect(agentStartMock).not.toHaveBeenCalled()
})

test('catch-up ignores duplicate clicks and permits retry after a failed launch', async () => {
  const user = userEvent.setup()
  let finish!: (value: { ok: boolean; message?: string }) => void
  agentStartMock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Catch me up' }))
  await user.click(screen.getByRole('button', { name: 'Starting catch-up' }))
  expect(agentStartMock).toHaveBeenCalledTimes(1)
  finish({ ok: false, message: 'Temporary launch failure' })
  expect(await screen.findByRole('alert')).toHaveTextContent('Temporary launch failure')
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(2))
})

test.each(['returned', 'thrown'] as const)(
  'a %s clean catch-up failure is shared with Mail remounted before settlement',
  async (failure) => {
    const user = userEvent.setup()
    let settle!: () => void
    agentStartMock.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          settle = () =>
            failure === 'returned'
              ? resolve({ ok: false, message: 'Temporary startup failure' })
              : reject(new Error('Temporary startup failure'))
        }),
    )
    const first = render(<MailShell />)
    await screen.findByRole('list', { name: 'Inbox' })
    await user.click(screen.getByRole('button', { name: 'Catch me up' }))
    first.unmount()
    render(<MailShell />)
    expect(await screen.findByRole('button', { name: 'Starting catch-up' })).toBeDisabled()
    settle()
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary startup failure')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  },
)

test('confirmed stop of the known survivor unlocks catch-up, but opening it does not', async () => {
  const user = userEvent.setup()
  agentStartMock.mockResolvedValueOnce({
    ok: false,
    cleanupUnconfirmed: true,
    sessionId: 'owned-survivor',
    message: 'Cleanup unconfirmed',
  })
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Catch me up' }))
  await user.click(await screen.findByRole('button', { name: 'Open surviving session' }))
  expect(screen.getByRole('button', { name: 'Catch me up' })).toBeDisabled()
  expect(agentStopMock).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Stop surviving session' }))
  await waitFor(() =>
    expect(agentStopMock).toHaveBeenCalledWith('syv-ai/vault', { id: 'owned-survivor' }),
  )
  await waitFor(() => expect(screen.getByRole('button', { name: 'Catch me up' })).toBeEnabled())
  expect(screen.queryByRole('alert')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Catch me up' }))
  await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(2))
})

test.each(['returned', 'thrown'] as const)(
  'a %s cleanup failure keeps catch-up locked with an explicit cleanup retry',
  async (failure) => {
    const user = userEvent.setup()
    agentStartMock.mockResolvedValueOnce({
      ok: false,
      cleanupUnconfirmed: true,
      sessionId: 'owned-survivor',
      message: 'Cleanup unconfirmed',
    })
    if (failure === 'returned')
      agentStopMock.mockResolvedValueOnce({ ok: false, message: 'Stop refused' })
    else agentStopMock.mockRejectedValueOnce(new Error('Stop refused'))
    render(<MailShell />)
    await screen.findByRole('list', { name: 'Inbox' })
    await user.click(screen.getByRole('button', { name: 'Catch me up' }))
    await user.click(await screen.findByRole('button', { name: 'Stop surviving session' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Stop refused')
    expect(screen.getByRole('button', { name: 'Catch me up' })).toBeDisabled()
    expect(agentStartMock).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Retry cleanup' }))
    await waitFor(() => expect(agentStopMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Catch me up' })).toBeEnabled())
  },
)

test.each(['vault', 'account'] as const)(
  'switching %s during cleanup cannot consume the confirmation',
  async (scope) => {
    const user = userEvent.setup()
    let finish!: (result: { ok: true }) => void
    agentStopMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    agentStartMock.mockResolvedValue({
      ok: false,
      cleanupUnconfirmed: true,
      sessionId: 'owned-survivor',
      message: 'Cleanup unconfirmed',
    })
    render(<MailShell />)
    await screen.findByRole('list', { name: 'Inbox' })
    await user.click(screen.getByRole('button', { name: 'Catch me up' }))
    await user.click(await screen.findByRole('button', { name: 'Stop surviving session' }))
    expect(await screen.findByRole('button', { name: 'Confirming stop…' })).toBeDisabled()
    if (scope === 'vault') {
      getDefaultStore().set(activeRemoteAtom, 'syv-ai/other')
      await waitFor(() => expect(screen.getByRole('button', { name: 'Catch me up' })).toBeEnabled())
      await user.click(screen.getByRole('button', { name: 'Catch me up' }))
      await screen.findByRole('button', { name: 'Stop surviving session' })
      getDefaultStore().set(activeRemoteAtom, 'syv-ai/vault')
      await screen.findByRole('button', { name: 'Confirming stop…' })
    } else {
      for (const sub of ['b', 'a']) {
        accountSub = sub
        getDefaultStore().set(refreshGoogleAtom)
        await waitFor(() =>
          expect(
            screen.getByRole('button', {
              name: `Google account ${sub === 'a' ? 'ada@syv.ai' : 'ada@home.test'}`,
            }),
          ).toBeInTheDocument(),
        )
      }
    }
    finish({ ok: true })
    await screen.findByRole('button', { name: 'Stop surviving session' })
    expect(screen.getByRole('button', { name: 'Catch me up' })).toBeDisabled()
    expect(getDefaultStore().get(mailCatchUpByVaultAtom).get('syv-ai/vault')?.kind).toBe(
      'uncertain',
    )
    if (scope === 'vault')
      expect(getDefaultStore().get(mailCatchUpByVaultAtom).get('syv-ai/other')?.kind).toBe(
        'uncertain',
      )
  },
)

test('an unknown native session id remains blocked without speculative stop or launch retry', async () => {
  const user = userEvent.setup()
  agentStartMock.mockResolvedValueOnce({
    ok: false,
    cleanupUnconfirmed: true,
    message: 'Native ownership unknown; identify the run in Claude Code before stopping it.',
  })
  const first = render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Catch me up' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('identify the run in Claude Code')
  first.unmount()
  render(<MailShell />)
  expect(await screen.findByRole('button', { name: 'Catch me up' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Stop surviving session' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Open surviving session' })).toBeNull()
  expect(agentStopMock).not.toHaveBeenCalled()
  expect(agentStartMock).toHaveBeenCalledTimes(1)
})
