/**
 * The app-shell-4 mail view, rendered on its own against faked Google
 * capabilities: what it asks Gmail for, what it shows, and that HTML bodies
 * still go through the sandboxed frame.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { getDefaultStore } from 'jotai'
import { activeRemoteAtom } from '@/plugin-api'
import { MailShell } from '../renderer/mail/app-shell'
import { resetMailImagesForTests } from '../renderer/mail-images'
import { resetMailFramesForTests } from '../renderer/mail-frames'

const searchMock = vi.fn()
const threadMock = vi.fn()
const draftsMock = vi.fn()
const markReadMock = vi.fn()
const starMock = vi.fn()
const archiveMock = vi.fn()
const trashMock = vi.fn()
const useAccountMock = vi.fn()
const toastMock = vi.fn()
const openExternal = vi.fn()

const google: Record<string, (params: unknown) => unknown> = {
  status: () => ({ account: { email: 'ada@syv.ai', sub: 'a' }, missingScopes: [] }),
  accounts: () => ({
    accounts: [
      { sub: 'a', email: 'ada@syv.ai' },
      { sub: 'b', email: 'ada@home.test' },
    ],
    current: 'a',
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
  markReadMock.mockReset().mockResolvedValue({ ok: true })
  starMock.mockReset().mockResolvedValue({ ok: true })
  archiveMock.mockReset().mockResolvedValue({ ok: true })
  trashMock.mockReset().mockResolvedValue({ ok: true })
  useAccountMock.mockReset().mockResolvedValue({ ok: true })
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

  await user.click(screen.getByRole('button', { name: 'Sent' }))
  await waitFor(() => expect(searchMock).toHaveBeenLastCalledWith({ mailbox: 'sent' }))

  await user.type(screen.getByRole('textbox', { name: 'Search mail' }), 'from:jane{Enter}')
  await waitFor(() => expect(searchMock).toHaveBeenLastCalledWith({ query: 'from:jane' }))
})

test('starred is Gmail’s is:starred', async () => {
  const user = userEvent.setup()
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })

  await user.click(screen.getByRole('button', { name: 'Starred' }))

  await waitFor(() => expect(searchMock).toHaveBeenLastCalledWith({ query: 'is:starred' }))
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

  await user.click(screen.getByRole('button', { name: 'Drafts' }))

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

test('compose opens the existing composer in a dialog', async () => {
  const user = userEvent.setup()
  render(<MailShell />)
  await screen.findByRole('list', { name: 'Inbox' })

  await user.click(screen.getByRole('button', { name: 'Compose new email' }))

  expect(await screen.findByRole('dialog', { name: 'New message' })).toBeInTheDocument()
})
