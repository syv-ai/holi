/**
 * The app-shell-4 mail view, rendered on its own against faked Google
 * capabilities: what it asks Gmail for, what it shows, and that HTML bodies
 * still go through the sandboxed frame.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { getDefaultStore } from 'jotai'
import { activeRemoteAtom, saveBeforeClosing } from '@/plugin-api'
import { MailShell } from '../renderer/mail/mail-shell'
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
const archiveMock = vi.fn()
const trashMock = vi.fn()
const useAccountMock = vi.fn()
const disconnectVaultMock = vi.fn()
const removeAccountMock = vi.fn()
const setClientMock = vi.fn()
let accountSub = 'a'
const toastMock = vi.fn()
const openExternal = vi.fn()

const google: Record<string, (params: unknown) => unknown> = {
  status: () => ({
    account:
      accountSub === ''
        ? null
        : { email: accountSub === 'a' ? 'ada@syv.ai' : 'ada@home.test', sub: accountSub },
    missingScopes: [],
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
  search: (p) => searchMock(p),
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
  archive: (p) => archiveMock(p),
  trash: (p) => trashMock(p),
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
  await user.click(await screen.findByRole('button', { name: 'Use in this vault' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(/draft.*not changed/i)
  expect(useAccountMock).not.toHaveBeenCalled()
  expect(editor).toHaveValue('still here')

  useAccountMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLink = () => {
          accountSub = 'b'
          resolve({ ok: true })
        }
      }),
  )
  await user.click(screen.getByRole('button', { name: 'Use in this vault' }))
  await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(2))
  expect(saveDraftMock.mock.calls.at(-1)![0]).toMatchObject({ mail: { subject: 'still here' } })
  await waitFor(() => expect(editor).toBeDisabled())
  finishLink()
  await waitFor(() => expect(useAccountMock).toHaveBeenCalledTimes(1))
  expect(accountSub).toBe('b')
  expect(
    await screen.findByRole('button', { name: 'Google account ada@home.test' }),
  ).toBeInTheDocument()
  expect(saveDraftMock.mock.calls.at(-1)![0]).toMatchObject({ mail: { subject: 'still here' } })
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
  expect(searchMock).toHaveBeenCalledWith({})
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
  const unreadRow = rows[0]!
  const readRow = rows[1]!
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

  // The earlier message is collapsed to its first line.
  expect(screen.getByRole('button', { name: /Expand message 1 of 2/ })).toBeInTheDocument()

  // An attachment opens the thread in Gmail.
  await user.click(screen.getByRole('button', { name: /^q2\.xlsx/ }))
  expect(openExternal).toHaveBeenCalledWith('https://mail.google.com/x')
})

test('the Unread tab asks Gmail for unread threads only', async () => {
  const user = userEvent.setup()
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })

  await user.click(screen.getByRole('tab', { name: 'Unread' }))

  await waitFor(() => expect(searchMock).toHaveBeenLastCalledWith({ unread: true }))
})

test('search sends Gmail grammar on Enter and escapes the folder', async () => {
  const user = userEvent.setup()
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })

  await user.click(screen.getByRole('button', { name: 'Mailbox: Inbox' }))
  await user.click(await screen.findByRole('menuitemradio', { name: 'Sent' }))
  await waitFor(() => expect(searchMock).toHaveBeenLastCalledWith({ mailbox: 'sent' }))

  await user.type(screen.getByRole('textbox', { name: 'Search mail' }), 'from:jane{Enter}')
  await waitFor(() => expect(searchMock).toHaveBeenLastCalledWith({ query: 'from:jane' }))
})

test('starred is one atomic navigation from Inbox and clears unread', async () => {
  const user = userEvent.setup()
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })
  await user.click(screen.getByRole('button', { name: 'Compose new email' }))
  await screen.findByRole('region', { name: 'Compose mail' })

  await user.click(screen.getByRole('tab', { name: 'Starred' }))

  await waitFor(() => expect(searchMock).toHaveBeenLastCalledWith({ query: 'is:starred' }))
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

test('a refused star reverts and says why', async () => {
  const user = userEvent.setup()
  starMock.mockRejectedValue(new Error('Insufficient permission'))
  render(<MailShell />)
  await user.click(await screen.findByText('Q2 budget', { selector: 'p' }))

  await user.click(await screen.findByRole('button', { name: 'Star thread' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(/Reconnect Google/)
  expect(screen.getByRole('button', { name: 'Star thread' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
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

test('the account menu switches the vault to another connected account', async () => {
  const user = userEvent.setup()
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })

  await user.click(await screen.findByRole('button', { name: 'Google account ada@syv.ai' }))
  await user.click(await screen.findByRole('menuitem', { name: 'ada@home.test' }))

  expect(useAccountMock).toHaveBeenCalledWith({ sub: 'b' })
})

test('compose opens the existing composer inline in the reader', async () => {
  const user = userEvent.setup()
  render(<MailShell visible />)
  await screen.findByRole('list', { name: 'Inbox' })

  await user.click(screen.getByRole('button', { name: 'Compose new email' }))

  expect(await screen.findByText('New message')).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('a failed composition save blocks thread, folder, compose, and account navigation', async () => {
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
  await user.click(await screen.findByRole('menuitem', { name: 'ada@home.test' }))
  expect(useAccountMock).not.toHaveBeenCalled()
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
