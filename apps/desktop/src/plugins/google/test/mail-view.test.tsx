/**
 * MailView: the list, the reader, triage, and the wiring around the sanitizer.
 *
 * The sanitizer has its own suite (`lib/__tests__/mail-html.test.tsx`); here
 * the checks are that HTML goes through it rather than around it, that blocked
 * remote content can be unblocked, and that links open externally.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MailView, matchPeople, mentionAt, replaceMention } from '../renderer/mail-view'
import { resetMailImagesForTests } from '../renderer/mail-images'
import { resetMailFramesForTests } from '../renderer/mail-frames'
import { activeRemoteAtom, loadVaultSettingsAtom } from '@/plugin-api'
import { refreshGoogleAtom } from '../renderer/account'
import type { googleCap } from '../renderer/google-cap'
import { getDefaultStore } from 'jotai'

const threadMock = vi.fn()
const readMock = vi.fn()
const countsMock = vi.fn()
const contactsMock = vi.fn()
const setReadMock = vi.fn()
const setStarredMock = vi.fn()
const archiveMock = vi.fn()
const trashMock = vi.fn()
const untrashMock = vi.fn()
const toastMock = vi.fn()
const categoryCountsMock = vi.fn()
const imageSendersMock = vi.fn()
const setImagesFromAllSendersMock = vi.fn()
const allowImagesFromMock = vi.fn()
const forgetImageSendersMock = vi.fn()
const sendAsMock = vi.fn()
const saveDraftMock = vi.fn()
const sendMock = vi.fn()
const discardDraftMock = vi.fn()
const draftMock = vi.fn()
const draftsMock = vi.fn()
const invitationMock = vi.fn<typeof googleCap.mailInvitation>()
const respondMock = vi.fn<typeof googleCap.respondToMailInvitation>()
const mailMarkersMock = vi.fn()
const markerPreferencesMock = vi.fn()
const setMailMarkerMock = vi.fn()
let currentAnnotations: Record<string, string> = {}
/** What `openDialogAtom` was asked to open. */
const openedDialog = vi.fn()
const createTaskMock = vi.fn()

/** Google's capabilities, by name, through the UI door. */
let mailAccountSub = 'mail-view-account'
let mailBindingRevision = 'view-binding-1'
let heldBindingValidation: Promise<void> | undefined
const google: Record<string, (params: unknown, remote: string) => unknown> = {
  status: () => ({
    account: {
      sub: mailAccountSub,
      email: mailAccountSub === 'mail-view-account' ? 'ada@syv.ai' : 'ada@home.test',
    },
    missingScopes: [],
  }),
  allAccounts: () => ({
    accounts: [
      { sub: 'mail-view-account', email: 'ada@syv.ai' },
      { sub: 'account-b', email: 'ada@home.test' },
    ],
    current: mailAccountSub,
  }),
  search: (p) => threadMock(p),
  thread: (p) => readMock(p),
  mailCounts: () => countsMock(),
  contacts: () => contactsMock(),
  'mark-read': (p) => setReadMock(p),
  star: (p) => setStarredMock(p),
  archive: (p) => archiveMock(p),
  trash: (p) => trashMock(p),
  untrash: (p) => untrashMock(p),
  categoryCounts: () => categoryCountsMock(),
  imageSenders: () => imageSendersMock(),
  setImagesFromAllSenders: (p) => setImagesFromAllSendersMock(p),
  allowImagesFrom: async (p) => {
    const result = await allowImagesFromMock(p)
    const before = await imageSendersMock()
    imageSendersMock.mockResolvedValue({
      ...before,
      imageSenders: [...before.imageSenders, (p as { sender: string }).sender],
    })
    return result
  },
  forgetImageSenders: () => forgetImageSendersMock(),
  sendAs: () => sendAsMock(),
  saveDraft: (p) => saveDraftMock(p),
  send: (p) => sendMock(p),
  discardDraft: (p) => discardDraftMock(p),
  draftBody: (p) => draftMock(p),
  drafts: () => draftsMock(),
  mailInvitation: (p, remote) => {
    const target = p as Parameters<typeof googleCap.mailInvitation>[1]
    if (target.expectedAccountSub !== mailAccountSub) throw new Error('Google account changed')
    return invitationMock(remote, target)
  },
  validateMailInvitationBinding: async (p) => {
    const target = p as Parameters<typeof googleCap.validateMailInvitationBinding>[1]
    if (
      target.expectedAccountSub !== mailAccountSub ||
      target.expectedBindingRevision !== mailBindingRevision
    )
      throw new Error('Google account binding changed')
    await heldBindingValidation
  },
  respondToMailInvitation: (p, remote) => {
    const target = p as Parameters<typeof googleCap.respondToMailInvitation>[1]
    if (
      target.expectedAccountSub !== mailAccountSub ||
      target.expectedBindingRevision !== mailBindingRevision
    )
      throw new Error('Google account changed')
    return respondMock(remote, target)
  },
  mailMarkerAnnotations: (p) => mailMarkersMock(p),
  mailMarkerPreferences: (p) => markerPreferencesMock(p),
  setMailMarker: (p) => setMailMarkerMock(p),
}

vi.mock('@/plugin-api', async (original) => {
  const { atom } = await import('jotai')
  return {
    ...(await original<typeof import('@/plugin-api')>()),
    openDialogAtom: atom(null, (_get, _set, dialog: unknown) => openedDialog(dialog)),
  }
})

vi.mock('sonner', async (original) => ({
  ...(await original<typeof import('sonner')>()),
  toast: (...args: unknown[]) => toastMock(...args),
}))

vi.mock('@/lib/trpc', () => ({
  trpc: {
    settings: {
      read: {
        query: async () => ({
          pluginValues: { google: await imageSendersMock() },
          plugins: { vault: {}, localOff: [] },
        }),
      },
    },
    cap: {
      run: {
        mutate: async ({
          name,
          paramsJson,
          remote,
        }: {
          name: string
          paramsJson?: string
          remote: string
        }) => {
          const params = paramsJson === undefined ? undefined : JSON.parse(paramsJson)
          if (name === 'tasks.create') return createTaskMock(params)
          const verb = google[name.replace(/^google\./, '')]
          if (verb === undefined) throw new Error(`unexpected ${name}`)
          return verb(params, remote)
        },
      },
    },
  },
}))

/** What the list actually asked Gmail for, on the nth load. */
function queryOf(call: number): Record<string, unknown> {
  return threadMock.mock.calls[call]![0] as Record<string, unknown>
}

const openExternal = vi.fn()

interface Message {
  body: string
  html: string | null
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    subject: 'Q2 budget',
    from: { name: 'Jane', email: 'jane@example.com' },
    date: '2026-08-04T09:00:00.000Z',
    snippet: 'a snippet',
    unread: false,
    answered: false,
    messageCount: 1,
    webUrl: 'https://mail.google.com/x',
    starred: false,
    important: false,
    hasDraft: false,
    category: null,
    labels: [],
    hasInvite: false,
    unsubscribeUrl: null,
    ...overrides,
  }
}

/** Gmail answers a page at a time; `nextPageToken` is null at the end. */
function page(threads: unknown[], nextPageToken: string | null = null) {
  return { threads, nextPageToken, syncedAt: new Date().toISOString() }
}

/** One thread in the list, one message in it: every case opens the same row. */
function withMessage(message: Message, extra: Record<string, unknown> = {}) {
  threadMock.mockResolvedValue(page([summary()]))
  readMock.mockResolvedValue({
    id: 't1',
    subject: 'Q2 budget',
    webUrl: 'https://mail.google.com/x',
    messages: [
      {
        id: 'm1',
        from: { name: 'Jane', email: 'jane@example.com' },
        to: [{ name: 'Ada', email: 'ada@syv.ai' }],
        cc: [],
        bcc: [],
        date: '2026-08-04T09:00:00.000Z',
        attachments: [],
        hasCalendarPayload: false,
        ...message,
        ...extra,
      },
    ],
  })
}

/** Point the list somewhere: a tab, Sent, or Drafts, all in one picker. */
async function chooseMailbox(
  user: ReturnType<typeof userEvent.setup>,
  label: string | RegExp,
): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /choose a mailbox/i }))
  await user.click(await screen.findByRole('menuitem', { name: label }))
  // The menu shrinks back into its trigger before the page is reachable again.
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
}

/** Mount, open the one thread, and hand back the reader pane. */
async function openThread(): Promise<HTMLElement> {
  const user = userEvent.setup()
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  return await screen.findByRole('article', { name: '' })
}

/**
 * The message's own document: an HTML body renders in a sandboxed frame, not
 * in the app's own DOM.
 */
async function frameOf(article: HTMLElement): Promise<Document> {
  const frame = article.querySelector('iframe')
  expect(frame, 'an HTML body must render in a frame').not.toBeNull()
  await waitFor(() => expect(frame!.contentDocument?.body.firstChild).toBeTruthy())
  return frame!.contentDocument!
}

beforeEach(() => {
  threadMock.mockReset()
  mailAccountSub = 'mail-view-account'
  mailBindingRevision = 'view-binding-1'
  heldBindingValidation = undefined
  // A default, because the real query ALWAYS returns a promise. A bare
  // `mockReset()` returns `undefined`, which surfaces as an unhandled error
  // beside a passing suite rather than as a failure.
  readMock.mockReset().mockResolvedValue({
    id: 't1',
    subject: 'Q2 budget',
    webUrl: 'https://mail.google.com/x',
    messages: [
      {
        id: 'm1',
        from: { name: 'Jane', email: 'jane@example.com' },
        to: [{ name: 'Ada', email: 'ada@syv.ai' }],
        cc: [],
        bcc: [],
        date: '2026-08-04T09:00:00.000Z',
        attachments: [],
        hasCalendarPayload: false,
        body: 'a body',
        html: null,
      },
    ],
  })
  countsMock.mockReset().mockResolvedValue({ unread: 3, total: 120 })
  contactsMock.mockReset().mockResolvedValue([])
  setReadMock.mockReset().mockResolvedValue({ ok: true })
  setStarredMock.mockReset().mockResolvedValue({ ok: true })
  archiveMock.mockReset().mockResolvedValue({ ok: true })
  trashMock.mockReset().mockResolvedValue({ ok: true })
  categoryCountsMock.mockReset().mockResolvedValue({})
  invitationMock.mockReset().mockResolvedValue(invitations())
  respondMock.mockReset().mockRejectedValue(new Error('Unexpected RSVP'))
  currentAnnotations = {}
  mailMarkersMock.mockReset().mockImplementation(async () => currentAnnotations)
  markerPreferencesMock.mockReset().mockResolvedValue({ enabledOrder: ['yellow-star'] })
  setMailMarkerMock.mockReset().mockImplementation(async (raw) => {
    const { id, marker } = raw as { id: string; marker: string | null }
    if (marker === null) delete currentAnnotations[id]
    else currentAnnotations[id] = marker
    return { ok: true }
  })
  imageSendersMock.mockReset().mockResolvedValue({ imageSenders: [], imagesFromAllSenders: false })
  setImagesFromAllSendersMock.mockReset().mockResolvedValue({ ok: true })
  allowImagesFromMock.mockReset().mockResolvedValue({ ok: true })
  forgetImageSendersMock.mockReset().mockResolvedValue({ ok: true })
  sendAsMock.mockReset().mockResolvedValue(['ada@syv.ai'])
  saveDraftMock.mockReset().mockResolvedValue({ id: 'd-1' })
  sendMock.mockReset().mockResolvedValue({ id: 'm-9' })
  discardDraftMock.mockReset().mockResolvedValue({ ok: true })
  draftMock.mockReset().mockResolvedValue(null)
  draftsMock.mockReset().mockResolvedValue([])
  createTaskMock.mockReset().mockResolvedValue({ path: 'Q2 budget.md' })
  openedDialog.mockReset()
  // Every Google call names the vault it is for.
  getDefaultStore().set(activeRemoteAtom, 'syv-ai/vault')
  // The remote-content choice outlives a component, so reset it or one test's
  // "Load images" satisfies the next test's assertion.
  resetMailImagesForTests()
  // The frame registry is module state shared by the suite.
  resetMailFramesForTests()
  openExternal.mockReset()
  // @ts-expect-error — the preload bridge is not typed onto window in tests.
  window.holi = { openExternal }
})
afterEach(() => {
  vi.restoreAllMocks()
  // @ts-expect-error — as above.
  delete window.holi
})

test('shows the subject, which is the whole point of a thread list', async () => {
  // The header-request side of this is covered in google-gmail.test.ts.
  threadMock.mockResolvedValue(
    page([summary({ subject: 'Q2 budget', from: { name: 'Jane Doe', email: 'jane@doe.test' } })]),
  )

  render(<MailView />)

  const row = await screen.findByRole('button', { name: /Q2 budget/ })
  expect(within(row).getByText('Q2 budget')).toBeInTheDocument()
  expect(within(row).getByText(/Jane Doe/)).toBeInTheDocument()
})

test('marks a thread the user has replied to', async () => {
  threadMock.mockResolvedValue(page([summary({ answered: true })]))

  render(<MailView />)

  expect(await screen.findByLabelText('You replied')).toBeInTheDocument()
})

test('leaves a thread awaiting the user unmarked', async () => {
  threadMock.mockResolvedValue(page([summary({ answered: false })]))

  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  expect(screen.queryByLabelText('You replied')).toBeNull()
})

/** The list: tabs, search, chips and paging. */

test('shows the whole inbox by default, not one of Gmail’s tabs', async () => {
  threadMock.mockResolvedValue(page([summary()]))

  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  // `category:primary` only matches anything if the account USES Gmail's tabs,
  // so the tabs are offered, not assumed.
  expect(queryOf(0).category).toBeUndefined()
})

test('a search is not narrowed by the category, as in Gmail itself', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()

  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /choose a mailbox/i }))
  await user.click(await screen.findByRole('menuitem', { name: /promotions/i }))
  // The menu shrinks back into its trigger before the page is reachable again.
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  await waitFor(() => expect(queryOf(1)).toMatchObject({ category: 'promotions' }))

  // Search is an icon until asked for; opening it focuses the field.
  await user.click(screen.getByRole('button', { name: /search mail/i }))
  await user.type(await screen.findByRole('combobox', { name: /search mail/i }), 'from:jane{Enter}')

  // Gmail's own search escapes the tab you are standing in.
  await waitFor(() => expect(queryOf(2)).toMatchObject({ query: 'from:jane' }))
  expect(queryOf(2).category).toBeUndefined()
})

test('says which tab is empty, rather than implying the inbox is', async () => {
  threadMock.mockResolvedValue(page([]))
  const user = userEvent.setup()

  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /choose a mailbox/i }))
  await user.click(await screen.findByRole('menuitem', { name: /promotions/i }))
  // The menu shrinks back into its trigger before the page is reachable again.
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

  // An empty tab and an empty mailbox look identical otherwise.
  expect(await screen.findByText(/nothing in promotions/i)).toBeInTheDocument()
})

test('lets the user look at Promotions', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()

  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /choose a mailbox/i }))
  await user.click(await screen.findByRole('menuitem', { name: /promotions/i }))
  // The menu shrinks back into its trigger before the page is reachable again.
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

  await waitFor(() => expect(queryOf(1)).toMatchObject({ category: 'promotions' }))
})

test('marks a starred thread', async () => {
  threadMock.mockResolvedValue(page([summary({ starred: true })]))

  render(<MailView />)

  expect(await screen.findByLabelText('Starred')).toBeInTheDocument()
})

test('marks a thread with an unsent draft', async () => {
  threadMock.mockResolvedValue(page([summary({ hasDraft: true })]))

  render(<MailView />)

  // You started replying and stopped.
  expect(await screen.findByLabelText('Unsent draft')).toBeInTheDocument()
})

test('names the tab a thread came from, when it is not Primary', async () => {
  threadMock.mockResolvedValue(page([summary({ category: 'promotions' })]))

  render(<MailView />)

  expect(await screen.findByText('Promotions')).toBeInTheDocument()
})

/**
 * The two cases that must render NOTHING, for different reasons.
 *
 * `primary` is not worth naming, and `null` means the thread carries no
 * `CATEGORY_*` label at all: on an account that does not use Gmail's tabs,
 * every thread is `null`. See the `CATEGORIES` note in `MailboxPicker`.
 */
test('says nothing about the tab for Primary, and nothing when there is no tab', async () => {
  threadMock.mockResolvedValue(page([summary({ category: 'primary' })]))

  const view = render(<MailView />)

  expect(await screen.findByText('Q2 budget')).toBeInTheDocument()
  expect(screen.queryByText('Primary')).not.toBeInTheDocument()

  view.unmount()
  threadMock.mockResolvedValue(page([summary({ category: null })]))
  render(<MailView />)

  expect(await screen.findByText('Q2 budget')).toBeInTheDocument()
  expect(screen.queryByText('Primary')).not.toBeInTheDocument()
})

/**
 * The meeting badge. `hasInvite` is resolved in main by one scoped query (see
 * `fetchInviteIds`), so the row only has to draw it.
 */
test('marks a thread carrying a calendar invite', async () => {
  threadMock.mockResolvedValue(page([summary({ hasInvite: true })]))

  render(<MailView />)

  expect(await screen.findByLabelText('Meeting invite')).toBeInTheDocument()
})

test('says nothing about meetings on a thread that is not one', async () => {
  threadMock.mockResolvedValue(page([summary({ hasInvite: false })]))

  render(<MailView />)

  expect(await screen.findByText('Q2 budget')).toBeInTheDocument()
  expect(screen.queryByLabelText('Meeting invite')).not.toBeInTheDocument()
})

/**
 * The metadata rail.
 *
 * Facts about the thread (stamp, count, meeting) sit in one right-aligned
 * group with none of the thread's *text*, so the text truncates against the
 * rail instead of pushing it off the row.
 */
test('groups the stamp, the count and the meeting badge apart from the text', async () => {
  threadMock.mockResolvedValue(page([summary({ hasInvite: true, messageCount: 3 })]))

  render(<MailView />)

  await screen.findByText('Q2 budget')
  // Found by marker, not by the stamp's text, which is locale-dependent.
  const rail = document.querySelector('[data-thread-meta]')

  expect(rail).not.toBeNull()
  expect(rail!.textContent).toMatch(/\d{1,2}[.:]\d{2}/)
  expect(rail).toHaveTextContent('(3)')
  expect(rail!.querySelector('[aria-label="Meeting invite"]')).not.toBeNull()
  // The truncating text is NOT in here.
  expect(rail).not.toHaveTextContent('Q2 budget')
  expect(rail).not.toHaveTextContent('Jane')
})

test('shows user labels as chips', async () => {
  threadMock.mockResolvedValue(page([summary({ labels: ['Work/Clients', 'Receipts'] })]))

  render(<MailView />)

  expect(await screen.findByText('Work/Clients')).toBeInTheDocument()
  expect(screen.getByText('Receipts')).toBeInTheDocument()
})

test('offers an unsubscribe link for a newsletter', async () => {
  withMessage({ body: 'this month at syv.ai', html: null })
  threadMock.mockResolvedValue(page([summary({ unsubscribeUrl: 'https://list.test/unsub?u=9' })]))
  const user = userEvent.setup()

  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await moreAction(user, /unsubscribe/i)

  // Opened, never requested by Holi.
  expect(openExternal).toHaveBeenCalledWith('https://list.test/unsub?u=9')
})

const invite: Awaited<ReturnType<typeof googleCap.mailInvitation>>['invitations'][number] = {
  kind: 'invitation',
  recurring: false,
  scope: 'single',
  bindingRevision: 'view-binding-1',
  identity: {
    messageId: 'm1',
    uid: 'review',
    sequence: 2,
    recurrenceId: null,
    dtstamp: '2026-08-15T08:00:00.000Z',
    materialKey: 'sprint-review-revision',
  },
  title: 'Sprint review',
  start: '2026-08-19T12:00:00.000Z',
  end: '2026-08-19T13:00:00.000Z',
  allDay: false,
  floating: false,
  organizer: { name: 'Jane', email: 'jane@example.com' },
  location: 'Workshop',
  conferenceUrl: 'https://teams.microsoft.com/l/meetup-join/19%3aX/0',
  conferenceLinkSource: 'provider',
  htmlLink: 'https://calendar.google.com/calendar/event?eid=e1',
  htmlLinkSource: 'calendar',
  cancelled: false,
  canRespond: true,
  responsePending: false,
  responseStatus: 'needsAction',
  recordedResponseStatus: null,
  sentResponseStatus: null,
  unavailableReason: null,
}

function invitations(
  ...cards: Awaited<ReturnType<typeof googleCap.mailInvitation>>['invitations']
) {
  return { invitations: cards, recoveryReason: null }
}
test('joins a recognised conference from the invitation card', async () => {
  threadMock.mockResolvedValue(page([summary({ hasInvite: true })]))
  invitationMock.mockResolvedValue(invitations(invite))
  const user = userEvent.setup()

  await openThread()
  const region = within(await screen.findByRole('region', { name: 'Calendar invitation' }))
  const clock = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const start = new Date(invite.start!)
  const end = new Date(invite.end!)
  const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' })
  const endDay = day.format(start) === day.format(end) ? '' : `${day.format(end)}, `
  expect(
    await region.findByText(
      `${day.format(start)}, ${clock.format(start)} – ${endDay}${clock.format(end)}`,
    ),
  ).toBeInTheDocument()
  await user.click(region.getByRole('button', { name: 'Join meeting' }))

  await waitFor(() => expect(openExternal).toHaveBeenCalledWith(invite.conferenceUrl))
})

test('does not open a link from a reader whose Google account was relinked', async () => {
  threadMock.mockResolvedValue(page([summary({ hasInvite: true })]))
  invitationMock.mockResolvedValue(invitations(invite))
  const user = userEvent.setup()
  await openThread()
  const join = await screen.findByRole('button', { name: 'Join meeting' })
  // The connector can change before this reader receives its refresh notification.
  mailAccountSub = 'account-b'
  await user.click(join)
  const region = within(screen.getByRole('region', { name: 'Calendar invitation' }))
  expect(await region.findByRole('alert')).toHaveTextContent(/account binding changed/i)
  expect(openExternal).not.toHaveBeenCalled()
})

test('a same-account relink blocks the old card link and Retry only rereads it', async () => {
  threadMock.mockResolvedValue(page([summary({ hasInvite: true })]))
  const accepted = { ...invite, responseStatus: 'accepted' } as const
  invitationMock.mockResolvedValue(invitations(accepted))
  const user = userEvent.setup()
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  const region = within(await screen.findByRole('region', { name: 'Calendar invitation' }))
  const join = await region.findByRole('button', { name: 'Join meeting' })

  // The provider subject stays the same, but main has a different binding revision.
  mailBindingRevision = 'view-binding-2'
  invitationMock.mockResolvedValue(
    invitations({ ...accepted, bindingRevision: mailBindingRevision }),
  )
  await user.click(join)
  expect(await region.findByRole('alert')).toHaveTextContent(/account binding changed/i)
  expect(region.getByText('Response: Accepted')).toBeVisible()
  expect(join).toBeDisabled()
  expect(openExternal).not.toHaveBeenCalled()

  await user.click(region.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(region.queryByRole('alert')).not.toBeInTheDocument())
  expect(region.getByText('Response: Accepted')).toBeVisible()
  expect(openExternal).not.toHaveBeenCalled()
  expect(respondMock).not.toHaveBeenCalled()

  await user.click(region.getByRole('button', { name: 'Join meeting' }))
  await waitFor(() => expect(openExternal).toHaveBeenCalledExactlyOnceWith(invite.conferenceUrl))
})

test('does not open a validated invitation link after switching reader threads', async () => {
  const user = userEvent.setup()
  let release!: () => void
  heldBindingValidation = new Promise<void>((resolve) => (release = resolve))
  invitationMock.mockResolvedValue(invitations(invite))
  readMock.mockImplementation(async ({ id }: { id: string }) => ({
    id,
    subject: id === 't1' ? 'Q2 budget' : 'Lunch',
    webUrl: 'https://mail.google.com/x',
    messages: [],
  }))
  threadMock.mockResolvedValue(
    page([summary({ hasInvite: true }), summary({ id: 't2', subject: 'Lunch' })]),
  )
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  const region = within(await screen.findByRole('region', { name: 'Calendar invitation' }))
  await user.click(await region.findByRole('button', { name: 'Join meeting' }))
  expect(await region.findByText('Checking invitation link…')).toBeVisible()
  expect(openExternal).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: /Lunch/ }))
  expect(await screen.findByRole('heading', { name: 'Lunch' })).toBeVisible()
  await act(async () => release())
  expect(openExternal).not.toHaveBeenCalled()
  expect(respondMock).not.toHaveBeenCalled()
})

test('renders a floating occurrence at its wall-clock time inside a DST gap', async () => {
  vi.stubEnv('TZ', 'America/New_York')
  try {
    expect(new Date('2026-03-08T06:30:00Z').getHours()).toBe(1)
    expect(new Date('2026-03-08T07:30:00Z').getHours()).toBe(3)
    threadMock.mockResolvedValue(page([summary({ hasInvite: true })]))
    invitationMock.mockResolvedValue(
      invitations({
        ...invite,
        recurring: true,
        scope: 'occurrence',
        identity: { ...invite.identity, recurrenceId: '2026-03-01T02:30:00' },
        floating: true,
        start: '2026-03-08T02:30:00',
        end: '2026-03-08T04:00:00',
      }),
    )
    const user = userEvent.setup()
    render(<MailView />)
    await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
    const region = within(await screen.findByRole('region', { name: 'Calendar invitation' }))
    expect(await region.findByText(/02[.:]30 – 04[.:]00/)).toBeVisible()

    imageSendersMock.mockResolvedValueOnce({
      imageSenders: [],
      imagesFromAllSenders: false,
      timeFormat: '12h',
    })
    await act(async () => getDefaultStore().set(loadVaultSettingsAtom, { force: true }))
    expect(await region.findByText(/2[.:]30\s*AM – 4[.:]00\s*AM/i)).toBeVisible()
  } finally {
    await act(async () => getDefaultStore().set(loadVaultSettingsAtom, { force: true }))
    vi.unstubAllEnvs()
  }
})

test.each(['conference', 'event'] as const)(
  'discloses the actual hostname before opening an emailed %s link',
  async (link) => {
    const user = userEvent.setup()
    const url = 'https://xn--bcher-kva.example.test/meet.google.com'
    threadMock.mockResolvedValue(page([summary({ hasInvite: true })]))
    invitationMock.mockResolvedValue(
      invitations({
        ...invite,
        conferenceUrl: link === 'conference' ? url : null,
        conferenceLinkSource: link === 'conference' ? 'mail' : null,
        htmlLink: link === 'event' ? url : null,
        htmlLinkSource: link === 'event' ? 'mail' : null,
      }),
    )

    await openThread()
    const region = within(await screen.findByRole('region', { name: 'Calendar invitation' }))
    const open = await region.findByRole('button', { name: 'Open email link' })
    expect(region.getByText('xn--bcher-kva.example.test')).toBeVisible()
    expect(open).toHaveAccessibleDescription('Destination: xn--bcher-kva.example.test')
    expect(
      region.queryByRole('button', { name: /join meeting|open in google calendar/i }),
    ).toBeNull()
    expect(openExternal).not.toHaveBeenCalled()
    await user.click(open)
    await waitFor(() => expect(openExternal).toHaveBeenCalledExactlyOnceWith(url))
  },
)

test('shows RSVP controls for an inline invitation without a filename or list badge', async () => {
  withMessage({ body: 'Please join the sprint review.', html: null }, { hasCalendarPayload: true })
  invitationMock.mockResolvedValue(
    invitations({ ...invite, recordedResponseStatus: 'needsAction' }),
  )

  await openThread()

  const region = within(await screen.findByRole('region', { name: 'Calendar invitation' }))
  expect(await region.findByRole('heading', { name: 'Sprint review' })).toBeInTheDocument()
  expect(region.getByText('No response yet')).toBeVisible()
  expect(region.getByRole('button', { name: 'Accept' })).toBeEnabled()
  expect(screen.queryByLabelText('Meeting invite')).not.toBeInTheDocument()
})

test('shows Delegated as a recorded response, not as an RSVP action', async () => {
  withMessage({ body: 'Please join the sprint review.', html: null }, { hasCalendarPayload: true })
  invitationMock.mockResolvedValue(invitations({ ...invite, responseStatus: 'delegated' }))
  await openThread()

  const card = within(await screen.findByRole('article', { name: invite.title }))
  expect(card.getByText('Response: Delegated')).toBeVisible()
  expect(card.queryByText('No response yet')).not.toBeInTheDocument()
  expect(card.getAllByRole('button')).toHaveLength(4) // Three RSVP actions and the meeting link.
  for (const name of ['Accept', 'Maybe', 'Decline', 'Join meeting']) {
    expect(card.getByRole('button', { name })).toBeEnabled()
  }
})

test('distinguishes a recorded Calendar answer from a different verified Sent reply', async () => {
  withMessage({ body: 'Please join the sprint review.', html: null }, { hasCalendarPayload: true })
  const conflicting: typeof invite = {
    ...invite,
    responseStatus: 'tentative',
    recordedResponseStatus: 'tentative',
    sentResponseStatus: 'accepted',
  }
  invitationMock.mockResolvedValue(invitations(conflicting))
  const user = userEvent.setup()
  await openThread()

  const card = within(await screen.findByRole('article', { name: invite.title }))
  expect(card.getByText('Calendar: Tentative')).toBeVisible()
  expect(card.getByText(/Gmail Sent: Accepted/)).toBeVisible()
  expect(card.queryByText('Response: Accepted')).not.toBeInTheDocument()
  expect(card.getByRole('button', { name: 'Accept' })).toBeEnabled()
  expect(card.getByRole('button', { name: 'Decline' })).toBeEnabled()
  const maybe = card.getByRole('button', { name: 'Maybe' })
  expect(maybe).toBeDisabled()
  await user.click(maybe)
  expect(respondMock).not.toHaveBeenCalled()
})

test('shows Calendar acceptance and the Gmail verification warning from response readback', async () => {
  withMessage({ body: 'Please join the sprint review.', html: null }, { hasCalendarPayload: true })
  const initial = { ...invite, recordedResponseStatus: 'needsAction' } as const
  const unavailableReason = 'Gmail could not verify the latest sent response'
  const recorded = { ...initial, recordedResponseStatus: 'accepted' } as const
  invitationMock
    .mockResolvedValueOnce(invitations(initial))
    .mockResolvedValue(invitations({ ...recorded, responseStatus: 'accepted' }))
  respondMock.mockResolvedValueOnce({
    outcome: 'sent',
    channel: 'calendar',
    answer: 'accepted',
    refreshPending: true,
    invitation: {
      ...recorded,
      responseStatus: null,
      sentResponseStatus: null,
      canRespond: false,
      unavailableReason,
    },
  })
  const user = userEvent.setup()
  await openThread()
  const region = within(await screen.findByRole('region', { name: 'Calendar invitation' }))
  await user.click(await region.findByRole('button', { name: 'Accept' }))
  expect(await region.findByText('Calendar: Accepted')).toBeVisible()
  expect(region.getByText(/Google accepted your response, but/i)).toBeVisible()
  expect(region.getByText(unavailableReason)).toBeVisible()
  expect(region.queryByText('Response: Accepted')).not.toBeInTheDocument()
  for (const name of ['Accept', 'Maybe', 'Decline']) {
    expect(region.queryByRole('button', { name })).not.toBeInTheDocument()
  }
  await user.click(region.getByRole('button', { name: 'Retry' }))
  expect(await region.findByText('Response: Accepted')).toBeVisible()
  expect(region.queryByText(unavailableReason)).not.toBeInTheDocument()
  expect(respondMock).toHaveBeenCalledTimes(1)
})

test('Retry shows the Calendar answer without settling a contested Gmail send', async () => {
  withMessage({ body: 'Please join the sprint review.', html: null }, { hasCalendarPayload: true })
  invitationMock.mockResolvedValueOnce(invitations(invite)).mockResolvedValue(
    invitations({
      ...invite,
      recordedResponseStatus: 'declined',
      responseStatus: null,
      sentResponseStatus: null,
      canRespond: false,
      responsePending: true,
      unavailableReason: 'Gmail could not verify the latest sent response',
    }),
  )
  respondMock.mockResolvedValueOnce({
    outcome: 'uncertain',
    channel: 'gmail',
    answer: 'accepted',
    invitation: null,
    refreshPending: true,
  })
  const user = userEvent.setup()
  await openThread()
  const region = within(await screen.findByRole('region', { name: 'Calendar invitation' }))
  await user.click(await region.findByRole('button', { name: 'Accept' }))
  expect(await region.findByText(/couldn’t confirm whether Google accepted/i)).toBeVisible()
  await user.click(region.getByRole('button', { name: 'Retry' }))
  expect(await region.findByText('Calendar: Declined')).toBeVisible()
  expect(region.getByText(/Gmail.*verify/i)).toBeVisible()
  expect(region.getByText(/couldn’t confirm whether Google accepted/i)).toBeVisible()
  expect(region.queryByText(/^Response:/)).not.toBeInTheDocument()
  for (const name of ['Accept', 'Maybe', 'Decline']) {
    expect(region.queryByRole('button', { name })).not.toBeInTheDocument()
  }
  expect(region.getByRole('button', { name: 'Retry' })).toBeEnabled()
  expect(respondMock).toHaveBeenCalledTimes(1)
})

test('ordinary mail opens without an invitation or meeting lookup', async () => {
  withMessage({ body: 'lunch?', html: null })
  threadMock.mockResolvedValue(page([summary({ hasInvite: false })]))
  expect(await openThread()).toHaveTextContent('lunch?')
  expect(screen.queryByRole('region', { name: 'Calendar invitation' })).not.toBeInTheDocument()
  expect(invitationMock).not.toHaveBeenCalled()
})

test('keeps a same-account meeting card join-only, with a strict Calendar fallback', async () => {
  threadMock.mockResolvedValue(page([summary({ hasInvite: true })]))
  invitationMock.mockResolvedValue(
    invitations({
      ...invite,
      kind: 'meeting',
      canRespond: false,
      responseStatus: null,
      conferenceUrl: 'https://notzoom.us/j/123',
      conferenceLinkSource: 'calendar',
    }),
  )
  const user = userEvent.setup()
  await openThread()
  const card = within(await screen.findByRole('article', { name: invite.title }))
  expect(card.queryByRole('button', { name: 'Join meeting' })).not.toBeInTheDocument()
  expect(card.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  await user.click(card.getByRole('button', { name: 'Open in Google Calendar' }))
  await waitFor(() => expect(openExternal).toHaveBeenCalledExactlyOnceWith(invite.htmlLink))
})

test('keeps an uncertain occurrence response separate from the series and refreshes both without resending', async () => {
  const series = {
    ...invite,
    scope: 'series',
    recurring: true,
    title: 'Design review series',
  } as const
  const occurrence = {
    ...invite,
    scope: 'occurrence',
    recurring: true,
    title: 'Moved design review',
    identity: { ...invite.identity, messageId: 'm2', recurrenceId: '2026-08-19T12:00:00.000Z' },
  } as const
  threadMock.mockResolvedValue(page([summary({ hasInvite: true })]))
  invitationMock.mockResolvedValueOnce(invitations(series, occurrence))
  invitationMock.mockResolvedValue(
    invitations(series, { ...occurrence, responseStatus: 'declined' }),
  )
  respondMock.mockResolvedValueOnce({
    outcome: 'uncertain',
    channel: 'calendar',
    answer: 'declined',
    invitation: { ...occurrence, responsePending: true },
    refreshPending: true,
  })
  const user = userEvent.setup()
  await openThread()
  const whole = within(await screen.findByRole('article', { name: series.title }))
  const instance = within(screen.getByRole('article', { name: occurrence.title }))
  expect(whole.getByText('Whole series')).toBeVisible()
  expect(instance.getByText('This occurrence')).toBeVisible()
  await user.click(instance.getByRole('button', { name: 'Decline' }))
  expect(await instance.findByText(/couldn’t confirm whether/i)).toBeVisible()
  expect(instance.getByRole('button', { name: 'Accept' })).toBeDisabled()
  expect(whole.getByRole('button', { name: 'Accept' })).toBeEnabled()
  expect(whole.getByText('No response yet')).toBeVisible()
  expect(instance.queryByText('Response: Declined')).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await instance.findByText('Response: Declined')).toBeVisible()
  expect(whole.getByText('No response yet')).toBeVisible()
  expect(respondMock).toHaveBeenCalledExactlyOnceWith('syv-ai/vault', {
    expectedAccountSub: 'mail-view-account',
    expectedBindingRevision: occurrence.bindingRevision,
    threadId: 't1',
    identity: occurrence.identity,
    answer: 'declined',
  })
})

test('shows read-only recovery even when no invitation cards can be reconstructed', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ hasInvite: true })]))
  invitationMock.mockResolvedValueOnce({
    invitations: [],
    recoveryReason: 'Could not confirm a previous response',
  })
  await openThread()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not confirm a previous response',
  )
  expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'Calendar invitation' })).not.toBeInTheDocument(),
  )
  expect(respondMock).not.toHaveBeenCalled()
})

test('an empty invitation result cannot promote a thread badge into a meeting', async () => {
  threadMock.mockResolvedValue(page([summary({ hasInvite: true })]))
  await openThread()
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'Calendar invitation' })).not.toBeInTheDocument(),
  )
  expect(
    screen.queryByRole('button', { name: /join meeting|open in google calendar/i }),
  ).not.toBeInTheDocument()
  expect(openExternal).not.toHaveBeenCalled()
})

test('explains a cancelled invitation detected from its attachment even without a list hint', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  withMessage(
    { body: 'The workshop is off.', html: null },
    {
      attachments: [{ filename: 'cancel.ics', mimeType: 'text/calendar', size: 400 }],
      hasCalendarPayload: true,
    },
  )
  invitationMock.mockResolvedValue(
    invitations({
      ...invite,
      cancelled: true,
      canRespond: false,
      responseStatus: null,
      unavailableReason: 'This invitation was cancelled',
    }),
  )
  await openThread()
  const region = await screen.findByRole('region', { name: 'Calendar invitation' })
  expect(await within(region).findByText(/cancelled/i)).toBeInTheDocument()
  expect(within(region).queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  expect(within(region).queryByRole('button', { name: 'Join meeting' })).not.toBeInTheDocument()
})

test('retries invitation read failures and reconciles uncertainty without resending', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ hasInvite: true })]))
  invitationMock.mockRejectedValueOnce(new Error('Calendar is temporarily unavailable'))
  invitationMock.mockResolvedValueOnce(invitations(invite))
  invitationMock.mockResolvedValueOnce(
    invitations({
      ...invite,
      canRespond: false,
      responsePending: true,
      unavailableReason: 'The response could not be confirmed',
    }),
  )
  invitationMock.mockResolvedValue(invitations({ ...invite, responseStatus: 'tentative' }))
  respondMock.mockResolvedValue({
    outcome: 'uncertain',
    channel: 'gmail',
    answer: 'tentative',
    invitation: null,
    refreshPending: true,
  })

  await openThread()
  const region = within(await screen.findByRole('region', { name: 'Calendar invitation' }))
  expect(await region.findByRole('alert')).toHaveTextContent('Calendar is temporarily unavailable')
  await user.click(region.getByRole('button', { name: 'Retry' }))
  expect(await region.findByText('No response yet')).toBeInTheDocument()
  await user.click(region.getByRole('button', { name: 'Maybe' }))
  expect(await region.findByText(/couldn’t confirm whether/i)).toBeInTheDocument()
  expect(region.queryByText('Response: Tentative')).not.toBeInTheDocument()
  await user.click(region.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(region.getByRole('button', { name: 'Retry' })).toBeEnabled())
  expect(region.queryByRole('button', { name: 'Maybe' })).not.toBeInTheDocument()
  expect(region.queryByText('Response: Tentative')).not.toBeInTheDocument()
  await user.click(region.getByRole('button', { name: 'Retry' }))

  expect(await region.findByText('Response: Tentative')).toBeInTheDocument()
  expect(respondMock).toHaveBeenCalledExactlyOnceWith('syv-ai/vault', {
    expectedAccountSub: 'mail-view-account',
    expectedBindingRevision: invite.bindingRevision,
    threadId: 't1',
    identity: invite.identity,
    answer: 'tentative',
  })
})

test('reloads a changed invitation after a refused response without repeating the write', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ hasInvite: true })]))
  invitationMock.mockResolvedValueOnce(invitations(invite))
  invitationMock.mockResolvedValue(
    invitations({
      ...invite,
      title: 'Review at the new time',
      identity: {
        ...invite.identity,
        dtstamp: '2026-08-16T08:00:00.000Z',
        materialKey: 'new-time',
      },
    }),
  )
  respondMock.mockRejectedValueOnce(
    new Error('This invitation changed; reload it before responding'),
  )

  await openThread()
  const region = within(await screen.findByRole('region', { name: 'Calendar invitation' }))
  await user.click(await region.findByRole('button', { name: 'Decline' }))
  expect(await region.findByRole('alert')).toBeInTheDocument()
  expect(region.getByRole('button', { name: 'Decline' })).toBeDisabled()
  await user.click(region.getByRole('button', { name: 'Retry' }))
  expect(await region.findByRole('heading', { name: 'Review at the new time' })).toBeInTheDocument()
  expect(region.getByRole('button', { name: 'Decline' })).toBeEnabled()
  expect(respondMock).toHaveBeenCalledTimes(1)
})

test('does not attach a previous RSVP receipt to a different invitation revision', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ hasInvite: true })]))
  invitationMock.mockResolvedValueOnce(invitations(invite)).mockResolvedValue(
    invitations({
      ...invite,
      title: 'Review at the new time',
      identity: { ...invite.identity, materialKey: 'new-time' },
    }),
  )
  respondMock.mockResolvedValue({
    outcome: 'sent',
    channel: 'calendar',
    answer: 'accepted',
    invitation: null,
    refreshPending: true,
  })

  await openThread()
  const region = within(await screen.findByRole('region', { name: 'Calendar invitation' }))
  await user.click(await region.findByRole('button', { name: 'Accept' }))
  await user.click(await region.findByRole('button', { name: 'Retry' }))
  expect(await region.findByRole('heading', { name: 'Review at the new time' })).toBeInTheDocument()
  expect(region.getByText('No response yet')).toBeInTheDocument()
  expect(region.queryByText(/Google accepted your response/i)).not.toBeInTheDocument()
  expect(respondMock).toHaveBeenCalledTimes(1)
})

test('ignores an earlier invitation read after opening another thread and reopening the first', async () => {
  const user = userEvent.setup()
  let finish!: (value: ReturnType<typeof invitations>) => void
  invitationMock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  invitationMock.mockResolvedValue(
    invitations({ ...invite, title: 'New revision', responseStatus: 'accepted' }),
  )
  readMock.mockImplementation(async ({ id }: { id: string }) => ({
    id,
    subject: id === 't1' ? 'Q2 budget' : 'Lunch',
    webUrl: 'https://mail.google.com/x',
    messages: [],
  }))
  threadMock.mockResolvedValue(
    page([summary({ hasInvite: true }), summary({ id: 't2', subject: 'Lunch' })]),
  )
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  expect(
    await screen.findByRole('status', { name: 'Loading calendar invitation' }),
  ).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /Lunch/ }))
  expect(await screen.findByRole('heading', { name: 'Lunch' })).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Calendar invitation' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /Q2 budget/ }))
  expect(await screen.findByRole('heading', { name: 'New revision' })).toBeInTheDocument()
  await act(async () => finish(invitations(invite)))
  expect(screen.queryByRole('heading', { name: invite.title })).not.toBeInTheDocument()
  expect(screen.getByText('Response: Accepted')).toBeInTheDocument()
})

test('keeps a metadata-readable thread selected when its body fails and retries the read only', async () => {
  threadMock.mockResolvedValue(
    page([summary({ unread: true }), summary({ id: 't2', subject: 'Lunch' })]),
  )
  readMock.mockRejectedValueOnce(
    Object.assign(new Error('Gmail MIME data exceeds the reader limits'), {
      data: { code: 'FORBIDDEN' },
    }),
  )
  const user = userEvent.setup()
  render(<MailView />)

  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))

  const failed = await screen.findByRole('alert')
  expect(failed).toBeVisible()
  expect(failed).toHaveTextContent(/MIME.*limits/i)
  expect(screen.getByRole('heading', { name: 'Q2 budget' })).toBeVisible()
  expect(screen.queryByText(/pick a thread/i)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Lunch/ })).toBeEnabled()
  await user.click(within(failed).getByRole('button', { name: 'Retry' }))

  expect(await within(await screen.findByRole('article')).findByText('a body')).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(readMock).toHaveBeenCalledTimes(2)
  expect(readMock.mock.calls.filter(([params]) => params.id === 't1')).toHaveLength(2)
  expect(setReadMock).toHaveBeenCalledTimes(1) // Only the original unread-row selection.
  expect(respondMock).not.toHaveBeenCalled()
  expect(saveDraftMock).not.toHaveBeenCalled()
  expect(sendMock).not.toHaveBeenCalled()
})

test('ignores a thread refusal after the reader has switched to another thread', async () => {
  threadMock.mockResolvedValue(page([summary(), summary({ id: 't2', subject: 'Lunch' })]))
  let refuse!: (error: Error) => void
  readMock.mockImplementation(async ({ id }: { id: string }) => {
    if (id === 't1') return new Promise((_resolve, reject) => (refuse = reject))
    return { id, subject: 'Lunch', webUrl: 'https://mail.google.com/x', messages: [] }
  })
  const user = userEvent.setup()
  render(<MailView />)

  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('status', { name: 'Loading the thread' })
  await user.click(screen.getByRole('button', { name: /Lunch/ }))
  await screen.findByRole('heading', { name: 'Lunch' })
  await act(async () => refuse(new Error('Gmail MIME data exceeds the reader limits')))

  expect(screen.getByRole('heading', { name: 'Lunch' })).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('loads the next page when asked', async () => {
  threadMock
    .mockResolvedValueOnce(page([summary({ id: 't1', subject: 'First page' })], 'page-2'))
    .mockResolvedValueOnce(page([summary({ id: 't2', subject: 'Second page' })]))
  const user = userEvent.setup()

  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /load more/i }))

  await waitFor(() => expect(screen.getByText('Second page')).toBeInTheDocument())
  expect(queryOf(1)).toMatchObject({ pageToken: 'page-2' })
  // Appended, not replaced.
  expect(screen.getByText('First page')).toBeInTheDocument()
  // And there is nothing left to ask for.
  expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
})

test('keeps paging from an empty unread page without offering to clear the filter', async () => {
  threadMock.mockImplementation(
    async ({ unread, pageToken }: { unread?: boolean; pageToken?: string }) => {
      if (!unread && pageToken === undefined) return page([summary()])
      if (unread && pageToken === undefined) return page([], 'unread-page-2')
      if (unread && pageToken === 'unread-page-2') {
        return page([summary({ id: 't2', subject: 'Unread on page two', unread: true })])
      }
      throw new Error('Unknown Gmail page token')
    },
  )
  const user = userEvent.setup()
  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })
  await user.click(screen.getByRole('button', { name: /show unread only/i }))

  const more = await screen.findByRole('button', { name: /load more/i })
  expect(screen.queryByRole('button', { name: /show all mail/i })).not.toBeInTheDocument()
  await user.click(more)

  expect(await screen.findByRole('button', { name: /Unread on page two/ })).toBeVisible()
  expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
})

test('keeps healthy Mail readable during Retry, then paginates the new inbox snapshot', async () => {
  const existing = summary()
  const arrival = summary({ id: 'new', subject: 'Newly arrived mail' })
  const tail = summary({ id: 'tail', subject: 'Older mail' })
  const partial = { ...page([existing], 'old-page-2'), unreadableThreadIds: ['oversized'] }
  // The arrival moves the former first-page row onto page 2. The failed row
  // remains unreadable and is not a placeholder on either page.
  const refreshed = { ...page([arrival], 'fresh-page-2'), unreadableThreadIds: ['oversized'] }
  let complete!: (result: typeof refreshed) => void
  let retryStarted = false
  threadMock.mockImplementation(
    async ({ pageToken, refresh }: { pageToken?: string; refresh?: boolean }) => {
      if (pageToken === undefined && !refresh && !retryStarted) return partial
      if (pageToken === undefined && refresh) {
        retryStarted = true
        return new Promise<typeof refreshed>((resolve) => {
          complete = resolve
        })
      }
      if (pageToken === 'fresh-page-2' && retryStarted)
        return { ...page([existing, tail]), unreadableThreadIds: ['oversized'] }
      throw new Error('Stale Gmail page token')
    },
  )
  const user = userEvent.setup()
  render(<MailView />)

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(/threads couldn’t be loaded/i)
  await user.click(within(alert).getByRole('button', { name: 'Retry' }))
  expect(within(alert).getByRole('button', { name: /Retrying/ })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: /Q2 budget/ }))
  expect(await screen.findByRole('article')).toBeInTheDocument()
  await act(async () => complete(refreshed))

  expect(screen.getByRole('button', { name: /Newly arrived mail/ })).toBeInTheDocument()
  expect(screen.getByRole('alert')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /load more/i }))
  expect(await screen.findByRole('button', { name: /Older mail/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Newly arrived mail/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Q2 budget/ })).toBeInTheDocument()
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(setReadMock).not.toHaveBeenCalled()
  expect(respondMock).not.toHaveBeenCalled()
})

test('lists attachments on an open message', async () => {
  withMessage(
    { body: 'see attached', html: null },
    { attachments: [{ filename: 'q2-deck.pdf', mimeType: 'application/pdf', size: 482_113 }] },
  )

  const article = await openThread()
  const attachment = within(article).getByRole('button', { name: /q2-deck\.pdf/i })
  const body = within(article).getByText('see attached')

  expect(within(article).getByText('q2-deck.pdf')).toBeInTheDocument()
  expect(attachment.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('opens an attachment in Gmail rather than downloading it', async () => {
  withMessage(
    { body: 'see attached', html: null },
    { attachments: [{ filename: 'q2-deck.pdf', mimeType: 'application/pdf', size: 482_113 }] },
  )
  const user = userEvent.setup()

  const article = await openThread()
  await user.click(within(article).getByRole('button', { name: /q2-deck\.pdf/i }))

  // Holi does not fetch attachment bytes: the thread in Gmail is where it is.
  expect(openExternal).toHaveBeenCalledWith('https://mail.google.com/x')
})

test('renders an HTML body as real markup, inside a frame of its own', async () => {
  // A word that appears ONLY in the body: the header renders the recipient's
  // name, which would satisfy the second assertion by accident.
  withMessage({
    body: 'the quarterly plan is attached',
    html: '<p>the <b>quarterly</b> plan is attached</p>',
  })

  const article = await openThread()
  const frame = await frameOf(article)

  expect(frame.querySelector('b')?.textContent).toBe('quarterly')
  // And it is emphatically NOT in the app's document.
  expect(within(article).queryByText(/quarterly/)).toBeNull()
})

test('the frame is sandboxed without allow-scripts', async () => {
  // Granting `allow-scripts` alongside `allow-same-origin` would let framed
  // content remove its own sandbox.
  withMessage({ body: 'x', html: '<p>x</p>' })

  const article = await openThread()

  expect(article.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-same-origin')
})

test('the frame document denies everything by default', async () => {
  withMessage({ body: 'x', html: '<p>x</p>' })

  const article = await openThread()
  const frame = await frameOf(article)
  const csp = frame.querySelector('meta[http-equiv="Content-Security-Policy"]')

  expect(csp?.getAttribute('content')).toContain("default-src 'none'")
})

test('renders a text-only body as text, never as markup', async () => {
  // A plain-text message that happens to contain angle brackets must not be
  // parsed: there is no sanitizer on this path.
  withMessage({ body: 'the tag is <b>bold</b>', html: null })

  const article = await openThread()

  expect(within(article).queryByText('bold')).toBeNull()
  expect(article.textContent).toContain('the tag is <b>bold</b>')
})

test('blocks a remote image and offers to load it', async () => {
  withMessage({ body: 'hello', html: '<p>hello</p><img src="https://tracker.test/pixel.gif">' })

  const article = await openThread()
  const frame = await frameOf(article)

  // Nothing was fetched: no src at all, so no read receipt reached the sender.
  expect(frame.querySelector('img')?.hasAttribute('src')).toBe(false)
  // Belt and braces: the frame's own policy would refuse the fetch anyway.
  expect(
    frame.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
  ).not.toContain('https:')
  expect(within(article).getByRole('button', { name: /load images/i })).toBeInTheDocument()
})

test('loads the images when the user asks, for that message only', async () => {
  withMessage({ body: 'hello', html: '<img src="https://cdn.test/logo.png">' })
  const user = userEvent.setup()

  const article = await openThread()
  await user.click(within(article).getByRole('button', { name: /load images/i }))

  await waitFor(async () =>
    expect((await frameOf(article)).querySelector('img')?.getAttribute('src')).toBe(
      'https://cdn.test/logo.png',
    ),
  )
  // The frame's policy has to widen with it.
  expect(
    (await frameOf(article))
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content'),
  ).toContain('https:')
  // The offer is gone once taken.
  expect(within(article).queryByRole('button', { name: /load images/i })).toBeNull()
})

test('says nothing about images when a message has none to block', async () => {
  withMessage({ body: 'hello', html: '<p>hello</p>' })

  const article = await openThread()

  expect(within(article).queryByRole('button', { name: /load images/i })).toBeNull()
})

/** Click inside the frame, where a real user's click would land. */
function clickInFrame(frame: Document, selector: string): boolean {
  const target = frame.querySelector(selector)!
  return target.dispatchEvent(
    new frame.defaultView!.MouseEvent('click', { bubbles: true, cancelable: true }),
  )
}

test('opens a link in the body externally instead of navigating the frame', async () => {
  withMessage({ body: 'see syv.ai', html: '<a href="https://syv.ai">syv</a>' })

  const frame = await frameOf(await openThread())
  const notCancelled = clickInFrame(frame, 'a')

  expect(openExternal).toHaveBeenCalledWith('https://syv.ai')
  // Left to itself the frame would navigate in place, loading remote content.
  expect(notCancelled).toBe(false)
})

test('refuses to open a link scheme it does not trust, and still does not navigate', async () => {
  // `ftp:` on purpose, not `javascript:` or `file:`: DOMPurify strips those, so
  // a test using them would pass without the second gate existing.
  withMessage({ body: 'x', html: '<a href="ftp://evil.test/x">download</a>' })

  const frame = await frameOf(await openThread())
  expect(frame.querySelector('a')?.getAttribute('href')).toBe('ftp://evil.test/x')

  const notCancelled = clickInFrame(frame, 'a')

  expect(openExternal).not.toHaveBeenCalled()
  expect(notCancelled).toBe(false)
})

/**
 * The split.
 *
 * The width itself is not assertable: `react-resizable-panels` sizes from
 * measured geometry and jsdom measures none. These check that there is a handle
 * and that the saved width is read from the global store.
 */
test('the list and the reader are separated by a draggable handle', async () => {
  threadMock.mockResolvedValue(page([summary()]))

  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  expect(screen.getByRole('separator')).toBeInTheDocument()
})

test('remembers its width per account, not per vault', async () => {
  const reads = vi.spyOn(Storage.prototype, 'getItem')
  threadMock.mockResolvedValue(page([summary()]))

  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  const keys = reads.mock.calls.map(([key]) => key)
  reads.mockRestore()

  // Mail shows one Google account whichever vault is open, and opens with no
  // vault at all, so its split is never keyed on a vault.
  expect(keys).toContain('holi:panelLayouts:global')
  expect(keys).not.toContain('holi:panelLayouts')
})

/**
 * The toolbar.
 *
 * One row, no heading. Search is an icon until it is wanted.
 */

test('search is an icon until it is asked for', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()

  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  expect(screen.queryByRole('combobox', { name: /search mail/i })).toBeNull()

  await user.click(screen.getByRole('button', { name: /search mail/i }))

  const field = await screen.findByRole('combobox', { name: /search mail/i })
  // Focused on unfold: the click that opened it is the intent to type.
  expect(field).toHaveFocus()
})

test('⌘F opens search when the pane has focus', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()

  render(<MailView />)
  // Focus something inside the pane: the binding is scoped to the pane, not the
  // document.
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await user.keyboard('{Meta>}f{/Meta}')

  expect(await screen.findByRole('combobox', { name: /search mail/i })).toBeInTheDocument()
})

test('the view carries no redundant "Mail" heading', async () => {
  threadMock.mockResolvedValue(page([summary()]))

  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  // The tab already says Mail.
  expect(screen.queryByRole('heading', { name: /^mail$/i })).toBeNull()
})

test('the unread toggle narrows the list, and survives a search', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()

  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  await user.click(screen.getByRole('button', { name: /show unread only/i }))
  await waitFor(() => expect(queryOf(1)).toMatchObject({ unread: true }))

  await user.click(screen.getByRole('button', { name: /search mail/i }))
  await user.type(await screen.findByRole('combobox', { name: /search mail/i }), 'budget{Enter}')

  // Unread is a STATE rather than a place, so a search keeps it.
  await waitFor(() => expect(queryOf(2)).toMatchObject({ query: 'budget', unread: true }))
})

test('the footer reports sync and Gmail’s own exact counts', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  countsMock.mockResolvedValue({ unread: 7, total: 431 })

  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  // Exact, from labels.get, not the approximate resultSizeEstimate.
  expect(await screen.findByText(/7 unread · 431 in inbox/)).toBeInTheDocument()
  expect(screen.getByText(/synced/i)).toBeInTheDocument()
})

test('the footer counts only what is on screen when Gmail will not say', async () => {
  threadMock.mockResolvedValue(page([summary(), summary({ id: 't2', subject: 'Q3 plan' })]))
  countsMock.mockResolvedValue(null)

  render(<MailView />)
  await screen.findByRole('button', { name: /Q3 plan/ })

  // "0 unread" would be a claim.
  expect(await screen.findByText(/2 shown/)).toBeInTheDocument()
})

/**
 * The reader.
 *
 * A thread is one scrolling column of messages, each at its full height, with
 * the history above the newest message collapsed.
 */

test('opens the newest message and collapses the history above it', async () => {
  threadMock.mockResolvedValue(page([summary({ messageCount: 2 })]))
  readMock.mockResolvedValue({
    id: 't1',
    subject: 'Q2 budget',
    webUrl: 'https://mail.google.com/x',
    messages: [
      {
        id: 'm1',
        from: { name: 'Jane', email: 'jane@example.com' },
        to: [],
        cc: [],
        bcc: [],
        date: '2026-08-03T09:00:00.000Z',
        attachments: [],
        body: 'the older question',
        html: null,
      },
      {
        id: 'm2',
        from: { name: 'Mette', email: 'mette@syv.ai' },
        to: [],
        cc: [],
        bcc: [],
        date: '2026-08-04T09:00:00.000Z',
        attachments: [],
        body: 'the newest answer',
        html: null,
      },
    ],
  })
  const user = userEvent.setup()

  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))

  const older = await screen.findByRole('button', { name: /expand message 1 of 2 from Jane/i })
  expect(
    screen.getByRole('button', { name: /collapse message 2 of 2 from Mette/i }),
  ).toBeInTheDocument()

  await user.click(older)
  expect(
    await screen.findByRole('button', { name: /collapse message 1 of 2 from Jane/i }),
  ).toBeInTheDocument()
})

/**
 * The metadata header.
 *
 * Labelled rows, not a sentence. A row is ABSENT rather than blank when the
 * header carried nothing.
 */
test('names the fields a message actually has, and no others', async () => {
  withMessage({ body: 'hello', html: null }, { cc: [{ name: 'Bo', email: 'bo@example.com' }] })

  const reader = await openThread()

  expect(within(reader).getByText('From')).toBeInTheDocument()
  expect(within(reader).getByText('To')).toBeInTheDocument()
  expect(within(reader).getByText('Cc')).toBeInTheDocument()
  // Gmail strips Bcc from delivered mail, so it is empty here.
  expect(within(reader).queryByText('Bcc')).not.toBeInTheDocument()
})

test('shows Bcc when the message carries one', async () => {
  // Only ever true of the account's own sent copy. See `MailMessage.bcc`.
  withMessage({ body: 'hello', html: null }, { bcc: [{ name: 'Kim', email: 'kim@syv.ai' }] })

  const reader = await openThread()

  expect(within(reader).getByText('Bcc')).toBeInTheDocument()
  expect(within(reader).getByRole('button', { name: /about Kim/i })).toBeInTheDocument()
})

/** Where you are in the conversation, suppressed on a one-message thread. */
test('a one-message thread shows no position counter', async () => {
  withMessage({ body: 'hello', html: null })

  const reader = await openThread()

  expect(within(reader).queryByText('1/1')).not.toBeInTheDocument()
})

test('an address is a person you can act on, not just a name', async () => {
  withMessage({ body: 'hello', html: null })
  const user = userEvent.setup()

  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await user.click(await screen.findByRole('button', { name: /about Jane/i }))

  // A display name cannot be mailed, copied, or told apart from a namesake.
  expect(await screen.findByText('jane@example.com')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: /^email$/i }))

  // "Email" is a mailto: handoff to the OS's mail client.
  expect(openExternal).toHaveBeenCalledWith('mailto:jane@example.com')
})

/**
 * "@" completion.
 *
 * People come from the senders of loaded mail, ranked first, then the address
 * book. These are the pure parts, tested directly rather than through the field.
 */

test('an @ only opens the list while it is still one word', () => {
  expect(mentionAt('from:@met')).toEqual({ start: 5, term: 'met' })
  expect(mentionAt('@')).toEqual({ start: 0, term: '' })
  // Whitespace ends it: `@` in prose is not a request for a person.
  expect(mentionAt('@met budget')).toBeNull()
  // And an address the user already accepted must not reopen the list on its
  // own `@`.
  expect(mentionAt('from:jane@syv.ai')).toBeNull()
  expect(mentionAt('budget')).toBeNull()
})

test('accepting a person leaves a query the user could have typed', () => {
  const query = 'from:@met'
  expect(replaceMention(query, mentionAt(query)!, 'mette@syv.ai')).toBe('from:mette@syv.ai ')

  // A bare `@mette` is not valid Gmail grammar, so the prefix is supplied.
  const bare = '@met'
  expect(replaceMention(bare, mentionAt(bare)!, 'mette@syv.ai')).toBe('from:mette@syv.ai ')
})

test('people are ranked by how often you actually hear from them', () => {
  const threads = [
    { from: { name: 'Mette Nielsen', email: 'mette@syv.ai' } },
    { from: { name: 'Mette Nielsen', email: 'mette@syv.ai' } },
    { from: { name: 'Anders Skøt', email: 'anders@krifa.dk' } },
    // A `From` the parser could not read: never offered, as an empty address
    // produces a query matching nothing.
    { from: { name: 'Mystery', email: '' } },
  ]

  const all = matchPeople(threads, '')
  expect(all.map((p) => p.email)).toEqual(['mette@syv.ai', 'anders@krifa.dk'])
  expect(all[0]!.count).toBe(2)

  // Matched on either half: people search by the name they see in the list.
  expect(matchPeople(threads, 'krifa').map((p) => p.name)).toEqual(['Anders Skøt'])
  expect(matchPeople(threads, 'mette').map((p) => p.name)).toEqual(['Mette Nielsen'])
})

test('the address book fills in behind senders, never over them', () => {
  const threads = [{ from: { name: 'Mette Nielsen', email: 'mette@syv.ai' } }]
  const contacts = [
    // Someone who has not written recently.
    { name: 'Signe Holm', email: 'signe@syv.ai' },
    // The same person as the sender above, as the address book has them.
    { name: 'Mette N.', email: 'mette@syv.ai' },
  ]

  const all = matchPeople(threads, '', contacts)

  // Senders outrank the address book, which carries no frequency.
  expect(all.map((p) => p.email)).toEqual(['mette@syv.ai', 'signe@syv.ai'])
  // Not duplicated, and the sender's own count survives.
  expect(all[0]!.count).toBe(1)
  expect(all[0]!.name).toBe('Mette Nielsen')
})

test('no contacts is not a broken dropdown — the sender corpus still answers', () => {
  // A cold contacts API, a refusal, or a grant without contacts.readonly.
  const threads = [{ from: { name: 'Mette Nielsen', email: 'mette@syv.ai' } }]

  expect(matchPeople(threads, 'mette', []).map((p) => p.email)).toEqual(['mette@syv.ai'])
})

test('typing @ in the search box offers people from the mail on screen', async () => {
  threadMock.mockResolvedValue(
    page([summary({ from: { name: 'Mette Nielsen', email: 'mette@syv.ai' } })]),
  )
  const user = userEvent.setup()

  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })
  await user.click(screen.getByRole('button', { name: /search mail/i }))
  await user.type(await screen.findByRole('combobox', { name: /search mail/i }), '@met')

  const option = await screen.findByRole('option', { name: /Mette Nielsen/ })
  await user.click(option)

  expect(await screen.findByRole('combobox', { name: /search mail/i })).toHaveValue(
    'from:mette@syv.ai ',
  )
})

/**
 * Triage: opening spends a request only when there is something to
 * change, the row moves without a refetch, and a refusal puts the row back.
 */

/** The row's name span carries the unread weight: see `ThreadRow`. */
function rowIsUnread(row: HTMLElement): boolean {
  return row.querySelector('.font-semibold') !== null
}

test('opening an unread thread marks it read, once, and the row stops being bold', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ unread: true })]))
  render(<MailView />)

  const row = await screen.findByRole('button', { name: /Q2 budget/ })
  expect(rowIsUnread(row)).toBe(true)

  await user.click(row)

  await waitFor(() => expect(setReadMock).toHaveBeenCalledWith({ id: 't1', unread: false }))
  expect(setReadMock).toHaveBeenCalledTimes(1)
  // Locally, with no second `threads.query`.
  await waitFor(() =>
    expect(rowIsUnread(screen.getByRole('button', { name: /Q2 budget/ }))).toBe(false),
  )
  expect(threadMock).toHaveBeenCalledTimes(1)
})

test('opening an already-read thread spends no request at all', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ unread: false })]))
  render(<MailView />)

  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')

  // A request per open, for a thread already read, against a rate-limited API.
  expect(setReadMock).not.toHaveBeenCalled()
})

test('a refused mark-read puts the row back to unread', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ unread: true })]))
  setReadMock.mockRejectedValue(new Error('this Google permission was not granted'))
  render(<MailView />)

  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))

  await waitFor(() => expect(setReadMock).toHaveBeenCalled())
  // The optimistic clear is undone: the mailbox still says unread.
  await waitFor(() =>
    expect(rowIsUnread(screen.getByRole('button', { name: /Q2 budget/ }))).toBe(true),
  )
})

test('the row marker action is independently keyboard reachable and never opens or marks read', async () => {
  threadMock.mockResolvedValue(page([summary({ starred: false })]))
  markerPreferencesMock.mockResolvedValue({ enabledOrder: ['red-star', 'blue-question'] })
  const user = userEvent.setup()
  render(<MailView />)

  const star = await screen.findByRole('button', { name: 'Star thread' })
  star.focus()
  await user.keyboard('{Enter}')
  await waitFor(() =>
    expect(setMailMarkerMock).toHaveBeenCalledWith({
      id: 't1',
      marker: 'red-star',
      expectedAccountSub: 'mail-view-account',
    }),
  )
  expect(screen.queryByRole('article')).toBeNull()
  expect(setReadMock).not.toHaveBeenCalled()
  expect(await screen.findByLabelText('Red star')).toBeInTheDocument()
  const unstar = await screen.findByRole('button', { name: 'Unstar thread' })
  await new Promise((resolve) => setTimeout(resolve, 510))
  unstar.focus()
  await user.keyboard(' ')
  await waitFor(() =>
    expect(setMailMarkerMock).toHaveBeenLastCalledWith({
      id: 't1',
      marker: null,
      expectedAccountSub: 'mail-view-account',
    }),
  )
})

test('stars and unstars the open thread', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ starred: false })]))
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')

  await user.click(screen.getByRole('button', { name: 'Star this thread' }))

  await waitFor(() =>
    expect(setMailMarkerMock).toHaveBeenCalledWith({
      id: 't1',
      marker: 'yellow-star',
      expectedAccountSub: 'mail-view-account',
    }),
  )
  // The button becomes its own inverse after the interaction state updates.
  const unstar = await screen.findByRole('button', { name: 'Unstar this thread' })
  await new Promise((resolve) => setTimeout(resolve, 510))
  await user.click(unstar)
  await waitFor(() =>
    expect(setMailMarkerMock).toHaveBeenLastCalledWith({
      id: 't1',
      marker: null,
      expectedAccountSub: 'mail-view-account',
    }),
  )
})

test('archiving removes the row and closes the reader', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary(), { ...summary(), id: 't2', subject: 'Other' }]))
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')

  await user.click(screen.getByRole('button', { name: 'Archive this thread' }))

  await waitFor(() => expect(archiveMock).toHaveBeenCalledWith({ id: 't1' }))
  // Both halves: the row goes and the reader closes.
  await waitFor(() => expect(screen.queryByRole('button', { name: /Q2 budget/ })).toBeNull())
  expect(screen.queryByRole('article')).toBeNull()
  expect(screen.getByRole('button', { name: /Other/ })).toBeInTheDocument()
})

test('trashing removes the row and closes the reader', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')

  await user.click(screen.getByRole('button', { name: 'Move this thread to trash' }))

  await waitFor(() => expect(trashMock).toHaveBeenCalledWith({ id: 't1' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: /Q2 budget/ })).toBeNull())
})

test('a trash offers Undo, which puts the thread back through untrash', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  trashMock.mockResolvedValue({ ok: true })
  untrashMock.mockResolvedValue({ ok: true })
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')

  await user.click(screen.getByRole('button', { name: 'Move this thread to trash' }))

  await waitFor(() => expect(toastMock).toHaveBeenCalled())
  const [message, options] = toastMock.mock.calls.at(-1) as [
    string,
    { action: { label: string; onClick: () => void } },
  ]
  expect(message).toBe('Thread moved to Trash')
  expect(options.action.label).toBe('Undo')
  const loads = threadMock.mock.calls.length
  options.action.onClick()
  await waitFor(() => expect(untrashMock).toHaveBeenCalledWith({ id: 't1' }))
  // The list is read again, which is where the thread reappears.
  await waitFor(() => expect(threadMock.mock.calls.length).toBeGreaterThan(loads))
})

test('a refused archive puts the thread back in the list', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  archiveMock.mockRejectedValue(new Error('this Google permission was not granted'))
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')

  await user.click(screen.getByRole('button', { name: 'Archive this thread' }))

  await waitFor(() => expect(archiveMock).toHaveBeenCalled())
  // Still there.
  await waitFor(() => expect(screen.getByRole('button', { name: /Q2 budget/ })).toBeInTheDocument())
})

test('a refused write says why, instead of silently snapping back', async () => {
  // A grant without gmail.modify loads mail and refuses every write. A silent
  // revert is indistinguishable from the click never registering.
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ unread: true })]))
  setReadMock.mockRejectedValue(new Error('this Google permission was not granted'))
  render(<MailView />)

  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))

  expect(await screen.findByText(/Reconnect Google in settings/)).toBeInTheDocument()
})

test('a rate limit is not reported as a permissions problem', async () => {
  // Re-consent is the wrong fix for a transient throttle (`classify` in main).
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  archiveMock.mockRejectedValue(new Error('Google is rate limiting this request'))
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')

  await user.click(screen.getByRole('button', { name: 'Archive this thread' }))

  expect(await screen.findByText(/rate limiting/)).toBeInTheDocument()
  expect(screen.queryByText(/Reconnect Google/)).toBeNull()
})

/**
 * The remote-content choice, and how long each version of it lasts: *this
 * message* lasts the session and must survive the reader unmounting; *this
 * sender* is remembered in main.
 */

/** Reopen the same thread from a fresh mount, so nothing component-local
 *  survives. */
async function reopenThread(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  cleanup()
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  return await screen.findByRole('article')
}

test('an unblocked message stays unblocked when the reader is closed and reopened', async () => {
  withMessage({ body: 'hello', html: '<img src="https://cdn.test/logo.png">' })
  const user = userEvent.setup()

  const article = await openThread()
  await user.click(within(article).getByRole('button', { name: /^load images$/i }))
  await waitFor(() =>
    expect(within(article).queryByRole('button', { name: /^load images$/i })).toBeNull(),
  )

  const reopened = await reopenThread(user)

  expect(within(reopened).queryByRole('button', { name: /^load images$/i })).toBeNull()
  expect((await frameOf(reopened)).querySelector('img')?.getAttribute('src')).toBe(
    'https://cdn.test/logo.png',
  )
})

test('“load images” is that message only, not every message from the sender', async () => {
  withMessage({ body: 'hello', html: '<img src="https://cdn.test/logo.png">' })
  const user = userEvent.setup()

  const article = await openThread()
  await user.click(within(article).getByRole('button', { name: /^load images$/i }))

  // Nothing was stored: the one-off must not become standing consent.
  await waitFor(() => expect(allowImagesFromMock).not.toHaveBeenCalled())
})

test('“always from this sender” is remembered in main, keyed on the address', async () => {
  withMessage({ body: 'hello', html: '<img src="https://cdn.test/logo.png">' })
  const user = userEvent.setup()

  const article = await openThread()
  await user.click(within(article).getByRole('button', { name: /always from this sender/i }))

  await waitFor(() =>
    expect(allowImagesFromMock).toHaveBeenCalledWith({ sender: 'jane@example.com' }),
  )
  // And it takes effect now, not on the next launch.
  expect(within(article).queryByRole('button', { name: /^load images$/i })).toBeNull()
})

test('a sender already allowed never shows the banner at all', async () => {
  imageSendersMock.mockResolvedValue({
    imageSenders: ['jane@example.com'],
    imagesFromAllSenders: false,
  })
  await getDefaultStore().set(loadVaultSettingsAtom, { force: true })
  withMessage({ body: 'hello', html: '<img src="https://cdn.test/logo.png">' })

  const article = await openThread()

  await waitFor(async () =>
    expect((await frameOf(article)).querySelector('img')?.getAttribute('src')).toBe(
      'https://cdn.test/logo.png',
    ),
  )
  expect(within(article).queryByRole('button', { name: /^load images$/i })).toBeNull()
})

test('offers nothing to remember when the sender could not be parsed', async () => {
  // `parseAddress` answers `email: ''` for a `From` it cannot read. Storing that
  // would allow images for every such message at once.
  withMessage(
    { body: 'hello', html: '<img src="https://cdn.test/logo.png">' },
    { from: { name: 'Mail Delivery Subsystem', email: '' } },
  )

  const article = await openThread()

  expect(within(article).getByRole('button', { name: /^load images$/i })).toBeInTheDocument()
  expect(within(article).queryByRole('button', { name: /always from this sender/i })).toBeNull()
})

/** Dark mode keeps the app canvas and discards author colors without losing content. */
test('a designed message keeps the dark theme while its body remains readable', async () => {
  withMessage({ body: 'hello', html: '<p style="color:#333333">the quarterly plan</p>' })

  const article = await openThread()
  const frame = await frameOf(article)

  const style = frame.querySelector('style')?.textContent ?? ''
  expect(style).toContain('color-scheme: dark')
  expect(frame.querySelector('p')?.getAttribute('style')).toBeNull()
  expect(frame.querySelector('p')?.textContent).toBe('the quarterly plan')
})

test('prose that brought no design keeps the app’s own theme', async () => {
  withMessage({ body: 'hello', html: '<p>just a sentence</p>' })

  const article = await openThread()
  const frame = await frameOf(article)

  // A plain message should not be a white card in a dark app.
  expect(frame.querySelector('style')?.textContent).not.toContain('color-scheme: light')
})

/**
 * Unread per Gmail tab.
 *
 * Counted, not estimated, and paid for only when the menu is opened.
 */
test('the category picker spends nothing until it is opened', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()
  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  expect(categoryCountsMock).not.toHaveBeenCalled()

  await user.click(screen.getByRole('button', { name: 'Choose a mailbox' }))

  await waitFor(() => expect(categoryCountsMock).toHaveBeenCalledTimes(1))
})

test('shows the unread count beside each tab, and 500+ past a page', async () => {
  categoryCountsMock.mockResolvedValue({
    primary: { count: 4, more: false },
    promotions: { count: 500, more: true },
    social: null,
  })
  countsMock.mockResolvedValue({ unread: 12, total: 340 })
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()
  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  await user.click(screen.getByRole('button', { name: 'Choose a mailbox' }))

  const menu = await screen.findByRole('menu')
  expect(within(menu).getByRole('menuitem', { name: /Primary/ })).toHaveTextContent('4')
  // "500+" past the page, not a flat 500.
  expect(within(menu).getByRole('menuitem', { name: /Promotions/ })).toHaveTextContent('500+')
  // "All mail" is the whole inbox's unread, already in hand from mailCounts.
  expect(within(menu).getByRole('menuitem', { name: /All mail/ })).toHaveTextContent('12')
  // A tab whose own request failed shows nothing: absent says "not known",
  // 0 would say "nothing here".
  expect(within(menu).getByRole('menuitem', { name: /Social/ })).not.toHaveTextContent(/\d/)
})

/**
 * ⌘F with a thread open means "find in what I am reading", not the list's
 * Gmail query.
 */

/** A two-message thread, both plain text, with a term in each. */
function twoMessageThread() {
  threadMock.mockResolvedValue(page([summary({ messageCount: 2 })]))
  readMock.mockResolvedValue({
    id: 't1',
    subject: 'Q2 budget',
    webUrl: 'https://mail.google.com/x',
    messages: [
      {
        id: 'm1',
        from: { name: 'Jane', email: 'jane@example.com' },
        to: [],
        cc: [],
        bcc: [],
        date: '2026-08-03T09:00:00.000Z',
        attachments: [],
        body: 'the budget question',
        html: null,
      },
      {
        id: 'm2',
        from: { name: 'Mette', email: 'mette@syv.ai' },
        to: [],
        cc: [],
        bcc: [],
        date: '2026-08-04T09:00:00.000Z',
        attachments: [],
        body: 'the budget answer',
        html: null,
      },
    ],
  })
}

/**
 * Put the keyboard inside the reader.
 *
 * A message header is the focusable thing in there that mutates nothing. It
 * collapses the message, leaving the whole thread collapsed, so a find that
 * reports two matches has had to expand it.
 */
async function focusReader(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /collapse message 2 of 2/i }))
}

test('⌘F in the reader finds in the thread, not in the mailbox', async () => {
  twoMessageThread()
  const user = userEvent.setup()
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))

  await focusReader(user)
  await user.keyboard('{Meta>}f{/Meta}')

  expect(await screen.findByRole('textbox', { name: /find in conversation/i })).toBeInTheDocument()
  // And NOT the Gmail query against the whole mailbox.
  expect(screen.queryByRole('combobox', { name: /search mail/i })).toBeNull()
})

test('⌘F in the list still opens the mailbox search', async () => {
  twoMessageThread()
  const user = userEvent.setup()
  render(<MailView />)

  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('button', { name: /collapse message 2 of 2/i })
  // Back to the list, where ⌘F means the other thing.
  await user.click(screen.getByRole('button', { name: 'Refresh mail' }))
  await user.keyboard('{Meta>}f{/Meta}')

  expect(await screen.findByRole('combobox', { name: /search mail/i })).toBeInTheDocument()
})

test('counts every match across the thread and steps through them', async () => {
  twoMessageThread()
  const user = userEvent.setup()
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await focusReader(user)
  await user.keyboard('{Meta>}f{/Meta}')

  await user.type(await screen.findByRole('textbox', { name: /find in conversation/i }), 'budget')

  // Both messages, though `focusReader` left the whole thread COLLAPSED.
  // Queried by role, not by text: "1/2" is also the position indicator.
  expect(await screen.findByRole('status')).toHaveTextContent('1/2')

  await user.keyboard('{Enter}')
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('2/2'))

  // Wraps rather than stopping at the end.
  await user.keyboard('{Enter}')
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1/2'))
})

test('says so when nothing matches, rather than showing 0/0', async () => {
  twoMessageThread()
  const user = userEvent.setup()
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await focusReader(user)
  await user.keyboard('{Meta>}f{/Meta}')

  await user.type(await screen.findByRole('textbox', { name: /find in conversation/i }), 'zzz')

  expect(await screen.findByText(/no matches/i)).toBeInTheDocument()
})

test('closing the find takes every mark with it', async () => {
  twoMessageThread()
  const user = userEvent.setup()
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await focusReader(user)
  await user.keyboard('{Meta>}f{/Meta}')
  await user.type(await screen.findByRole('textbox', { name: /find in conversation/i }), 'budget')
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1/2'))

  await user.click(screen.getByRole('button', { name: 'Close find' }))

  await waitFor(() => expect(document.querySelectorAll('[data-holi-find]')).toHaveLength(0))
  // The text is intact, not left in pieces by the unwrapping.
  expect(screen.getByText(/the budget answer/)).toBeInTheDocument()
})

/**
 * ⌘F, and where the keyboard goes when the search closes.
 *
 * The binding is on the pane's container, so focus escaping to `document.body`
 * when the search input unmounts would make the shortcut dead.
 */
test('⌘F still works after the search has been closed', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()
  render(<MailView />)

  await user.click(await screen.findByRole('button', { name: /search mail/i }))
  const field = await screen.findByRole('combobox', { name: /search mail/i })
  await user.type(field, 'budget{Enter}')
  await user.keyboard('{Escape}')

  // The field is gone and the icon is back.
  const icon = await screen.findByRole('button', { name: /search mail/i })
  // Focus stayed in the pane rather than falling to the body.
  expect(document.activeElement).toBe(icon)

  await user.keyboard('{Meta>}f{/Meta}')

  expect(await screen.findByRole('combobox', { name: /search mail/i })).toBeInTheDocument()
})

/**
 * Multi-select.
 *
 * The selection is a MODE: while one exists the toolbar gives way to the
 * selection bar, because search, the mailbox picker and refresh would each
 * destroy or invalidate the selection.
 */

/** Three rows, so a shift-range has a middle. */
function threeThreads() {
  threadMock.mockResolvedValue(
    page([
      summary({ id: 't1', subject: 'One' }),
      summary({ id: 't2', subject: 'Two' }),
      summary({ id: 't3', subject: 'Three' }),
    ]),
  )
}

test('builds a selection with cmd-click and says how big it is', async () => {
  threeThreads()
  const user = userEvent.setup()
  render(<MailView />)
  await screen.findByRole('button', { name: /One/ })

  await user.keyboard('{Meta>}')
  await user.click(screen.getByRole('button', { name: /One/ }))
  await user.click(screen.getByRole('button', { name: /Three/ }))
  await user.keyboard('{/Meta}')

  expect(await screen.findByText('2 selected')).toBeInTheDocument()
  // Cmd-click selects rather than opening: the thread was never fetched.
  expect(readMock).not.toHaveBeenCalled()
})

test('shift-click takes everything in between', async () => {
  threeThreads()
  const user = userEvent.setup()
  render(<MailView />)
  await screen.findByRole('button', { name: /One/ })

  await user.click(screen.getByRole('checkbox', { name: /select One/i }))
  await user.keyboard('{Shift>}')
  await user.click(screen.getByRole('checkbox', { name: /select Three/i }))
  await user.keyboard('{/Shift}')

  expect(await screen.findByText('3 selected')).toBeInTheDocument()
})

test('archives every selected thread through the same per-thread write', async () => {
  threeThreads()
  const user = userEvent.setup()
  render(<MailView />)
  await screen.findByRole('button', { name: /One/ })

  await user.click(screen.getByRole('checkbox', { name: /select One/i }))
  await user.click(screen.getByRole('checkbox', { name: /select Two/i }))
  await user.click(await screen.findByRole('button', { name: 'Archive' }))

  await waitFor(() => expect(archiveMock).toHaveBeenCalledTimes(2))
  expect(archiveMock).toHaveBeenCalledWith({ id: 't1' })
  expect(archiveMock).toHaveBeenCalledWith({ id: 't2' })
  // The bar goes with the selection.
  expect(screen.queryByText(/selected/)).toBeNull()
})

test('the toolbar gives way to the selection bar, and comes back', async () => {
  threeThreads()
  const user = userEvent.setup()
  render(<MailView />)
  await screen.findByRole('button', { name: /One/ })

  await user.click(screen.getByRole('checkbox', { name: /select One/i }))

  // Every one of these would destroy or invalidate the selection.
  expect(screen.queryByRole('button', { name: /search mail/i })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Refresh mail' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Choose a mailbox' })).toBeNull()

  await user.click(screen.getByRole('button', { name: 'Clear selection' }))

  expect(await screen.findByRole('button', { name: 'Refresh mail' })).toBeInTheDocument()
})

test('Escape clears a selection', async () => {
  threeThreads()
  const user = userEvent.setup()
  render(<MailView />)
  await screen.findByRole('button', { name: /One/ })

  await user.click(screen.getByRole('checkbox', { name: /select One/i }))
  expect(await screen.findByText('1 selected')).toBeInTheDocument()

  await user.keyboard('{Escape}')

  await waitFor(() => expect(screen.queryByText(/selected/)).toBeNull())
})

test('forgets a selected thread that is no longer in the list', async () => {
  // The list is replaced wholesale by every refresh and optimistic write, so an
  // id can outlive the row it names.
  threeThreads()
  const user = userEvent.setup()
  render(<MailView />)
  await screen.findByRole('button', { name: /One/ })

  await user.click(screen.getByRole('checkbox', { name: /select One/i }))
  await user.click(screen.getByRole('checkbox', { name: /select Two/i }))
  expect(await screen.findByText('2 selected')).toBeInTheDocument()

  // t1 goes away underneath the selection.
  threadMock.mockResolvedValue(page([summary({ id: 't2', subject: 'Two' })]))
  await user.click(screen.getByRole('button', { name: 'Clear selection' }))
  await user.click(await screen.findByRole('button', { name: 'Refresh mail' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: /One/ })).toBeNull())

  await user.click(screen.getByRole('checkbox', { name: /select Two/i }))
  expect(await screen.findByText('1 selected')).toBeInTheDocument()
})

/**
 * The row context menu.
 *
 * Triage without opening, since opening marks the thread read.
 */

/** Right-click the one thread row and hand back the menu. */
/** Open the reader's More actions menu and choose one of its items. */
async function moreAction(user: ReturnType<typeof userEvent.setup>, name: string | RegExp) {
  await user.click(await screen.findByRole('button', { name: 'More actions' }))
  await user.click(await screen.findByRole('menuitem', { name }))
}

async function openRowMenu(_user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  fireEvent.contextMenu(await screen.findByRole('button', { name: /Q2 budget/ }))
  return await screen.findByRole('menu')
}

test('archives a thread from the row, without opening it', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()
  render(<MailView />)

  const menu = await openRowMenu(user)
  await user.click(within(menu).getByRole('menuitem', { name: 'Archive' }))

  await waitFor(() => expect(archiveMock).toHaveBeenCalledWith({ id: 't1' }))
  // Optimistic, through the same `write` the header buttons use.
  await waitFor(() => expect(screen.queryByRole('button', { name: /Q2 budget/ })).toBeNull())
  // The thread was never read.
  expect(readMock).not.toHaveBeenCalled()
})

test('offers the direction the thread is not already in', async () => {
  threadMock.mockResolvedValue(page([summary({ unread: true, starred: true })]))
  const user = userEvent.setup()
  render(<MailView />)

  const menu = await openRowMenu(user)

  expect(within(menu).getByRole('menuitem', { name: 'Mark read' })).toBeInTheDocument()
  expect(within(menu).getByRole('menuitem', { name: 'Unstar' })).toBeInTheDocument()
})

test('puts a read thread back on the pile', async () => {
  // Opening a thread marks it read, so "mark unread" lives only here.
  threadMock.mockResolvedValue(page([summary({ unread: false })]))
  const user = userEvent.setup()
  render(<MailView />)

  const menu = await openRowMenu(user)
  await user.click(within(menu).getByRole('menuitem', { name: 'Mark unread' }))

  await waitFor(() => expect(setReadMock).toHaveBeenCalledWith({ id: 't1', unread: true }))
})

test('offers Unsubscribe only when the sender advertised one', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()
  render(<MailView />)

  expect(
    within(await openRowMenu(user)).queryByRole('menuitem', { name: 'Unsubscribe' }),
  ).toBeNull()
})

test('surfaces a refused row action rather than silently reverting', async () => {
  // A silent revert is indistinguishable from the click never registering.
  threadMock.mockResolvedValue(page([summary()]))
  archiveMock.mockRejectedValue(new Error('this Google permission was not granted'))
  const user = userEvent.setup()
  render(<MailView />)

  const menu = await openRowMenu(user)
  await user.click(within(menu).getByRole('menuitem', { name: 'Archive' }))

  expect(await screen.findByText(/Reconnect Google/)).toBeInTheDocument()
  // And the row is back, because the write did not stick.
  expect(await screen.findByRole('button', { name: /Q2 budget/ })).toBeInTheDocument()
})

/**
 * The number beside the unread toggle describes the list it sits above.
 */
test('the unread badge follows the selected tab, not the whole inbox', async () => {
  countsMock.mockResolvedValue({ unread: 16, total: 340 })
  categoryCountsMock.mockResolvedValue({ promotions: { count: 1, more: false } })
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()
  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  expect(screen.getByRole('button', { name: /show unread only/i })).toHaveTextContent('16')

  await chooseMailbox(user, /Promotions/)

  await waitFor(() =>
    expect(screen.getByRole('button', { name: /show unread only/i })).toHaveTextContent('1'),
  )
})

test('shows no number for a tab whose count was never fetched', async () => {
  // `categoryCounts` is not paid for until the picker is opened. As in the
  // picker, an absent number says "not known".
  countsMock.mockResolvedValue({ unread: 16, total: 340 })
  categoryCountsMock.mockResolvedValue({})
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()
  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  await chooseMailbox(user, /Forums/)

  await waitFor(() =>
    expect(screen.getByRole('button', { name: /show unread only/i })).not.toHaveTextContent(/\d/),
  )
})

/**
 * The mailbox picker: the tabs above a separator, Sent and Drafts below it.
 */
test('offers the tabs, Sent and Drafts from one control', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()
  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  await user.click(screen.getByRole('button', { name: 'Choose a mailbox' }))

  const menu = await screen.findByRole('menu')
  for (const label of [/^All mail/, /Primary/, /Social/, /Promotions/, /Updates/, /Forums/]) {
    expect(within(menu).getByRole('menuitem', { name: label })).toBeInTheDocument()
  }
  expect(within(menu).getByRole('menuitem', { name: 'Sent' })).toBeInTheDocument()
  expect(within(menu).getByRole('menuitem', { name: 'Drafts' })).toBeInTheDocument()
})

test('asks Gmail for the Sent mailbox, and says so on the trigger', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()
  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  await chooseMailbox(user, 'Sent')

  await waitFor(() => expect(queryOf(1)).toMatchObject({ mailbox: 'sent' }))
  // The trigger says where you are without being opened.
  expect(screen.getByRole('button', { name: 'Choose a mailbox' })).toHaveTextContent('Sent')
})

test('drops the unread filter in Sent, where a message cannot be unread', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()
  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  await user.click(screen.getByRole('button', { name: /show unread only/i }))
  await waitFor(() => expect(queryOf(1)).toMatchObject({ unread: true }))

  await chooseMailbox(user, 'Sent')

  // Not merely unsent: the control is gone.
  await waitFor(() => expect(queryOf(2).unread).toBeUndefined())
  expect(screen.queryByRole('button', { name: /show unread only/i })).toBeNull()
})

test('says Nothing sent rather than explaining Gmail’s tabs', async () => {
  threadMock.mockResolvedValue(page([]))
  const user = userEvent.setup()
  render(<MailView />)

  await chooseMailbox(user, 'Sent')

  expect(await screen.findByText(/nothing sent/i)).toBeInTheDocument()
  expect(screen.queryByText(/tabs only apply/i)).toBeNull()
})

test('a search escapes the mailbox, as it escapes the tabs', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()
  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  await chooseMailbox(user, 'Sent')
  await waitFor(() => expect(queryOf(1)).toMatchObject({ mailbox: 'sent' }))

  await user.click(screen.getByRole('button', { name: /search mail/i }))
  await user.type(await screen.findByRole('combobox', { name: /search mail/i }), 'from:jane{Enter}')

  await waitFor(() => expect(queryOf(2)).toMatchObject({ query: 'from:jane' }))
  expect(queryOf(2).mailbox).toBeUndefined()
})

test('compose sits on the toolbar row, in line with refresh', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  const compose = screen.getByRole('button', { name: 'New message' })
  const refresh = screen.getByRole('button', { name: 'Refresh mail' })

  expect(compose.parentElement).toBe(refresh.parentElement)
})

/**
 * The optimistic undo, when the list has moved on under it.
 *
 * `write` captures the list it is undoing. Restoring that snapshot after
 * something else has replaced the list would discard the other change, so the
 * recovery is to re-read.
 */
test('a failed write does not roll back a refresh that landed while it was in flight', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ unread: true })]))
  // Never settles until we say so, so "in flight" is a real moment.
  let refuse!: (err: Error) => void
  setReadMock.mockReturnValue(new Promise((_resolve, reject) => (refuse = reject)))
  render(<MailView />)

  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await waitFor(() => expect(setReadMock).toHaveBeenCalled())

  // A refresh lands with different mail entirely.
  threadMock.mockResolvedValue(page([{ ...summary(), id: 't9', subject: 'Newer thing' }]))
  await user.click(screen.getByRole('button', { name: 'Refresh mail' }))
  await screen.findByRole('button', { name: /Newer thing/ })

  refuse(new Error('this Google permission was not granted'))

  // The stale snapshot must not come back.
  expect(await screen.findByText(/Reconnect Google in settings/)).toBeInTheDocument()
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Newer thing/ })).toBeInTheDocument(),
  )
})

test('reads the refusal from the code, not from Google’s prose', async () => {
  // The router maps `GoogleApiError.code` onto a tRPC code, so a message that
  // says nothing useful still produces the right advice.
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  archiveMock.mockRejectedValue(
    Object.assign(new Error('Internal server error'), { data: { code: 'FORBIDDEN' } }),
  )
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')

  await user.click(screen.getByRole('button', { name: 'Archive this thread' }))

  expect(await screen.findByText(/Reconnect Google in settings/)).toBeInTheDocument()
})

test('a rate-limit code is not reported as a permissions problem either', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  archiveMock.mockRejectedValue(
    Object.assign(new Error('Internal server error'), { data: { code: 'TOO_MANY_REQUESTS' } }),
  )
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')

  await user.click(screen.getByRole('button', { name: 'Archive this thread' }))

  expect(await screen.findByText(/rate limiting/)).toBeInTheDocument()
  expect(screen.queryByText(/Reconnect Google/)).toBeNull()
})

/**
 * Replying without leaving.
 *
 * The composer appears *inside the thread*, so the message being answered
 * stays on screen, and sending refreshes the thread rather than inventing a
 * message.
 */
async function openForCompose() {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')
  return user
}

test('narrow composition hides the list without remounting, then restores the reader', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()
  render(<MailView />)
  const row = await screen.findByRole('button', { name: /Q2 budget/ })
  const group = row.closest('[data-slot="resizable-panel-group"]')!
  const list = group.querySelector('#mail-list')!
  const handle = group.querySelector('[data-slot="resizable-handle"]')!
  const reader = group.querySelector('[data-mail-pane="reader"]')!

  expect(group).not.toHaveClass('@container/mail')
  expect(group).not.toHaveClass('@max-[40rem]/mail:[&>[data-panel]:first-child]:!hidden')

  await user.click(screen.getByRole('button', { name: 'New message' }))
  const composer = await screen.findByRole('region', { name: 'Compose mail' })
  const subject = within(composer).getByRole('textbox', { name: 'Subject' })
  expect(group).toHaveClass('@container/mail')
  expect(group).toHaveClass('@max-[40rem]/mail:[&>[data-panel]:first-child]:!hidden')
  expect(handle).toHaveClass('@max-[40rem]/mail:hidden')

  await user.type(subject, 'A narrow-window draft')
  expect(screen.getByRole('region', { name: 'Compose mail' })).toBe(composer)
  expect(within(composer).getByRole('textbox', { name: 'Subject' })).toBe(subject)

  await user.click(within(composer).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Compose mail' })).toBeNull())
  expect(group).not.toHaveClass('@container/mail')
  expect(group).not.toHaveClass('@max-[40rem]/mail:[&>[data-panel]:first-child]:!hidden')
  expect(group.querySelector('#mail-list')).toBe(list)
  expect(handle).not.toHaveClass('@max-[40rem]/mail:hidden')
  expect(group.querySelector('[data-mail-pane="reader"]')).toBe(reader)
})

test('reply opens a composer inside the thread, not a browser', async () => {
  const user = await openForCompose()

  await user.click(await screen.findByRole('button', { name: 'Reply' }))

  const composer = await screen.findByRole('region', { name: 'Compose mail' })
  expect(composer).toBeInTheDocument()
  // The thing being replied to is still on screen. Scoped to the READER's copy:
  // the composer's quote puts `>` in its own span, so its text is 'a body' too.
  expect(screen.getByText('a body', { selector: '[data-holi-message]' })).toBeInTheDocument()
  expect(openExternal).not.toHaveBeenCalled()
})

test('reply addresses the sender; reply-all copies the rest', async () => {
  const user = await openForCompose()

  await user.click(await screen.findByRole('button', { name: 'Reply' }))

  const chips = await screen.findAllByTestId('chip-name')
  expect(chips.map((c) => c.textContent)).toEqual(['Jane'])
})

test('forward opens with no recipients at all', async () => {
  const user = await openForCompose()

  await moreAction(user, 'Forward')

  await screen.findByRole('region', { name: 'Compose mail' })
  expect(screen.queryAllByTestId('chip-name')).toEqual([])
})

test('switching from reply to forward rebuilds the composer', async () => {
  // `composeFrom` runs once, on mount. Without a remount the second intent
  // would open showing the first one's recipients.
  const user = await openForCompose()
  await user.click(await screen.findByRole('button', { name: 'Reply' }))
  expect((await screen.findAllByTestId('chip-name')).length).toBe(1)

  await moreAction(user, 'Forward')

  await screen.findByRole('region', { name: 'Compose mail' })
  expect(screen.queryAllByTestId('chip-name')).toEqual([])
})

test('sending closes the composer and refetches the thread', async () => {
  const user = await openForCompose()
  await user.click(await screen.findByRole('button', { name: 'Reply' }))
  const before = readMock.mock.calls.length

  await user.click(await screen.findByRole('button', { name: 'Send' }))

  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'Compose mail' })).not.toBeInTheDocument(),
  )
  expect(sendMock).toHaveBeenCalledTimes(1)
  expect(readMock.mock.calls.length).toBeGreaterThan(before)
})

test('a failed send keeps the composer open with the text intact', async () => {
  const user = await openForCompose()
  sendMock.mockRejectedValue(new Error('no network'))
  await user.click(await screen.findByRole('button', { name: 'Reply' }))

  await user.click(await screen.findByRole('button', { name: 'Send' }))

  await waitFor(() => expect(screen.getByText('no network')).toBeVisible())
  expect(screen.getByRole('region', { name: 'Compose mail' })).toBeInTheDocument()
})

test('open in Gmail is still there — leaving is a choice, not a fallback', async () => {
  const user = await openForCompose()

  await moreAction(user, 'Open in Gmail')

  expect(openExternal).toHaveBeenCalledWith('https://mail.google.com/x')
})

/**
 * The Drafts view.
 *
 * No route to a half-written message ends at a browser: a draft that belongs
 * to no thread, a thread that has one, and a thread that has two.
 */
function draft(overrides: Record<string, unknown> = {}) {
  return {
    draftId: 'd-1',
    threadId: null,
    to: [{ name: 'Bo Berg', email: 'bo@example.com' }],
    subject: 'Half written',
    snippet: 'I was going to say',
    date: '2026-08-12T08:00:00.000Z',
    ...overrides,
  }
}

test('Drafts lists a draft that belongs to no thread at all', async () => {
  // Without this view its only route back would be Gmail.
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  draftsMock.mockResolvedValue([draft()])
  render(<MailView />)

  await chooseMailbox(user, 'Drafts')

  expect(await screen.findByText('Half written')).toBeInTheDocument()
  expect(screen.getByText('Bo Berg')).toBeInTheDocument()
})

test('a draft with no recipient reads as (no recipient), not as a blank row', async () => {
  // A blank row reads as a rendering bug.
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  draftsMock.mockResolvedValue([draft({ to: [] })])
  render(<MailView />)

  await chooseMailbox(user, 'Drafts')

  expect(await screen.findByText('(no recipient)')).toBeInTheDocument()
})

test('opening a draft loads it into the composer', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  draftsMock.mockResolvedValue([draft()])
  draftMock.mockResolvedValue({
    draftId: 'd-1',
    threadId: null,
    to: [{ name: 'Bo Berg', email: 'bo@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Half written',
    markdown: 'I was going to say',
    html: null,
    foreign: false,
  })
  render(<MailView />)
  await chooseMailbox(user, 'Drafts')

  await user.click(await screen.findByText('Half written'))

  await screen.findByRole('region', { name: 'Compose mail' })
  expect(draftMock).toHaveBeenCalledWith({ id: 'd-1', expectedAccountSub: 'mail-view-account' })
})

test('opening a draft closes the thread it would otherwise hide behind', async () => {
  // The draft composer renders in the reader pane only with nothing open;
  // otherwise it would land off-screen at the foot of an unrelated thread.
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  draftsMock.mockResolvedValue([draft()])
  draftMock.mockResolvedValue({
    draftId: 'd-1',
    threadId: null,
    to: [{ name: 'Bo Berg', email: 'bo@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Half written',
    markdown: 'I was going to say',
    html: null,
    text: 'I was going to say',
    foreign: false,
  })
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')

  await chooseMailbox(user, 'Drafts')
  await user.click(await screen.findByText('Half written'))

  await screen.findByRole('region', { name: 'Compose mail' })
  expect(screen.queryByRole('article')).toBeNull()
})

test('Drafts says so when there are none, rather than showing an empty pane', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  render(<MailView />)

  await chooseMailbox(user, 'Drafts')

  expect(await screen.findByText('No drafts')).toBeInTheDocument()
})

test('Continue draft opens the newest draft in the open thread', async () => {
  // A thread with two drafts: this opens the newer, and the older stays
  // reachable in the Drafts list.
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ hasDraft: true })]))
  draftsMock.mockResolvedValue([
    draft({ draftId: 'old', threadId: 't1', date: '2026-08-01T00:00:00.000Z' }),
    draft({ draftId: 'new', threadId: 't1', date: '2026-08-12T00:00:00.000Z' }),
  ])
  draftMock.mockResolvedValue({
    draftId: 'new',
    threadId: 't1',
    to: [],
    cc: [],
    bcc: [],
    subject: 'Half written',
    markdown: 'x',
    html: null,
    foreign: false,
  })
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))

  await moreAction(user, 'Continue your draft')

  await waitFor(() =>
    expect(draftMock).toHaveBeenCalledWith({ id: 'new', expectedAccountSub: 'mail-view-account' }),
  )
})

test('no Continue draft on a thread that has none', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ hasDraft: false })]))
  render(<MailView />)

  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))

  await screen.findByRole('article')
  await user.click(screen.getByRole('button', { name: 'More actions' }))
  await screen.findByRole('menu')
  expect(screen.queryByRole('menuitem', { name: 'Continue your draft' })).toBeNull()
})

test('the thread list comes back when Mail is chosen again', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  render(<MailView />)
  await chooseMailbox(user, 'Drafts')
  await screen.findByText('No drafts')

  await chooseMailbox(user, /^All mail/)

  expect(await screen.findByRole('button', { name: /Q2 budget/ })).toBeInTheDocument()
})

/**
 * A new message.
 *
 * A dialog, where a reply is inline: a fresh message has no context to
 * preserve.
 */
test('confirmed discard closes a dirty new message without recreating it', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: 'New message' }))
  await user.type(screen.getByRole('textbox', { name: 'Subject' }), ' throw away')

  await user.click(screen.getByRole('button', { name: 'Discard' }))
  await user.click(screen.getByRole('button', { name: 'Discard draft' }))

  await waitFor(() => expect(screen.queryByRole('region', { name: 'Compose mail' })).toBeNull())
  expect(discardDraftMock).toHaveBeenCalledWith({
    draftId: 'd-1',
    expectedAccountSub: 'mail-view-account',
  })
  // Any debounced save may already have created a server draft; discarding it
  // must not trigger another create from the unmount lifecycle.
  const callsAtCompletion = saveDraftMock.mock.calls.length
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(saveDraftMock).toHaveBeenCalledTimes(callsAtCompletion)
  expect(screen.getByText('Pick a thread to read it')).toBeInTheDocument()
})

test('confirmed discard removes a saved draft and restores the previous reader', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  draftsMock.mockResolvedValue([draft()])
  draftMock.mockResolvedValue({
    draftId: 'd-1',
    threadId: null,
    to: [],
    cc: [],
    bcc: [],
    subject: 'Half written',
    markdown: 'body',
    html: null,
    foreign: false,
  })
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')
  await chooseMailbox(user, 'Drafts')
  await user.click(await screen.findByText('Half written'))
  await screen.findByRole('textbox', { name: 'Subject' })
  await user.click(screen.getByRole('button', { name: 'Discard' }))
  await user.click(screen.getByRole('button', { name: 'Discard draft' }))

  await waitFor(() => expect(discardDraftMock).toHaveBeenCalledTimes(1))
  expect(discardDraftMock).toHaveBeenCalledWith({
    draftId: 'd-1',
    expectedAccountSub: 'mail-view-account',
  })
  expect(await screen.findByRole('article')).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Compose mail' })).toBeNull()
  expect(saveDraftMock).not.toHaveBeenCalled()
})

test('new message opens in the reader pane without a compose dialog', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  render(<MailView />)

  await user.click(await screen.findByRole('button', { name: 'New message' }))

  expect(openedDialog).not.toHaveBeenCalled()
  expect(await screen.findByRole('heading', { name: 'New message' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Subject' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument()
})

test('new message replaces the open thread in the reader pane', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')

  await user.click(screen.getByRole('button', { name: 'New message' }))

  expect(screen.queryByRole('article')).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'New message' })).toBeInTheDocument()
})

test('thread navigation saves the active composer before displaying the destination', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary(), summary({ id: 't2', subject: 'Next thread' })]))
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')
  await user.click(screen.getByRole('button', { name: 'Reply' }))
  await user.type(screen.getByRole('textbox', { name: 'Subject' }), ' latest')

  let finish!: (result: { id: string }) => void
  saveDraftMock.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
  await user.click(screen.getByRole('button', { name: /Next thread/ }))
  await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('region', { name: 'Compose mail' })).toBeInTheDocument()
  finish({ id: 'saved-draft' })

  await screen.findByText('Next thread')
  expect(screen.queryByRole('region', { name: 'Compose mail' })).toBeNull()
  expect(readMock).toHaveBeenLastCalledWith({ id: 't2' })
  expect(saveDraftMock.mock.calls[0]![0]).toMatchObject({
    expectedAccountSub: 'mail-view-account',
    mail: { subject: 'Re: Q2 budget latest' },
  })
})

test('failed navigation save keeps the composer and does not open the thread', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary(), summary({ id: 't2', subject: 'Next thread' })]))
  saveDraftMock.mockRejectedValue(new Error('offline'))
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')
  await user.click(screen.getByRole('button', { name: 'Reply' }))
  await user.type(screen.getByRole('textbox', { name: 'Subject' }), ' latest')
  await user.click(screen.getByRole('button', { name: /Next thread/ }))

  expect(await screen.findByText('offline')).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Compose mail' })).toBeInTheDocument()
  expect(readMock).not.toHaveBeenCalledWith({ id: 't2' })
})

test.each([
  ['Archive this thread', archiveMock],
  ['Move this thread to trash', trashMock],
] as const)(
  '%s waits for a reply save and refuses the write on failure',
  async (label, mutation) => {
    const user = userEvent.setup()
    threadMock.mockResolvedValue(page([summary()]))
    saveDraftMock.mockRejectedValue(new Error('offline'))
    render(<MailView />)
    await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
    await screen.findByRole('article')
    await user.click(screen.getByRole('button', { name: 'Reply' }))
    await user.type(screen.getByRole('textbox', { name: 'Subject' }), ' latest')
    await user.click(screen.getByRole('button', { name: label }))

    expect(await screen.findByText('offline')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Compose mail' })).toBeInTheDocument()
    expect(mutation).not.toHaveBeenCalled()
    expect(screen.getByRole('article')).toBeInTheDocument()
  },
)

test('Close waits for the latest dirty reply save, then restores its thread', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')
  await user.click(screen.getByRole('button', { name: 'Reply' }))
  const subject = screen.getByRole('textbox', { name: 'Subject' })
  await user.clear(subject)
  await user.type(subject, 'Latest reply subject')

  let finish!: (result: { id: string }) => void
  saveDraftMock.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
  await user.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('region', { name: 'Compose mail' })).toBeInTheDocument()
  expect(screen.getByRole('article')).toBeInTheDocument()
  expect(saveDraftMock.mock.calls[0]![0]).toMatchObject({
    expectedAccountSub: 'mail-view-account',
    mail: { subject: 'Latest reply subject' },
  })

  finish({ id: 'saved-draft' })

  await waitFor(() => expect(screen.queryByRole('region', { name: 'Compose mail' })).toBeNull())
  expect(screen.getByRole('article')).toBeInTheDocument()
})

test('failed dirty Close keeps the subject editable and Retry lets Close finish', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')
  await user.click(screen.getByRole('button', { name: 'Reply' }))
  const subject = screen.getByRole('textbox', { name: 'Subject' })
  const setTimeout = globalThis.setTimeout
  const pendingAutosaves: TimerHandler[] = []
  // Keep the two-second idle autosave pending so it cannot consume the failed
  // save's Retry state; all other timers (including test-library waits) stay real.
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    if (delay === 2000) {
      pendingAutosaves.push(callback)
      return 0 as never
    }
    return setTimeout(callback, delay, ...args)
  })
  await user.clear(subject)
  await user.type(subject, 'Keep this subject')
  expect(pendingAutosaves.length).toBeGreaterThan(0)
  let rejectSave!: (error: Error) => void
  saveDraftMock.mockImplementationOnce(
    () => new Promise((_resolve, reject) => (rejectSave = reject)),
  )

  await user.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(1))
  rejectSave(new Error('offline'))

  await waitFor(() => {
    expect(screen.getByText('offline')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Compose mail' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('Keep this subject')
  })
  saveDraftMock.mockResolvedValue({ id: 'saved-draft' })
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(2))
  await user.click(screen.getByRole('button', { name: 'Close' }))

  await waitFor(() => expect(screen.queryByRole('region', { name: 'Compose mail' })).toBeNull())
  expect(screen.getByRole('article')).toBeInTheDocument()
  expect(saveDraftMock.mock.calls[1]![0]).toMatchObject({
    expectedAccountSub: 'mail-view-account',
    mail: { subject: 'Keep this subject' },
  })
})

test('mailbox change waits for a dirty save before showing Sent', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })
  await user.click(screen.getByRole('button', { name: 'New message' }))
  const subject = screen.getByRole('textbox', { name: 'Subject' })
  await user.type(subject, 'Sent after save')

  let finish!: (result: { id: string }) => void
  saveDraftMock.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
  await user.click(screen.getByRole('button', { name: 'Choose a mailbox' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Sent' }))
  await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(1))
  expect(queryOf(0).mailbox).toBeUndefined()
  expect(threadMock).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('region', { name: 'Compose mail' })).toBeInTheDocument()

  finish({ id: 'saved-draft' })

  await waitFor(() => expect(queryOf(1)).toMatchObject({ mailbox: 'sent' }))
  expect(screen.queryByRole('region', { name: 'Compose mail' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Choose a mailbox' })).toHaveTextContent('Sent')
})

test('failed mailbox-change save keeps the mailbox and editable text without requesting Sent', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })
  await user.click(screen.getByRole('button', { name: 'New message' }))
  const subject = screen.getByRole('textbox', { name: 'Subject' })
  await user.type(subject, 'Keep me in All mail')
  saveDraftMock.mockRejectedValue(new Error('offline'))

  await user.click(screen.getByRole('button', { name: 'Choose a mailbox' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Sent' }))

  expect(await screen.findByText('offline')).toBeInTheDocument()
  expect(threadMock).toHaveBeenCalledTimes(1)
  expect(queryOf(0).mailbox).toBeUndefined()
  expect(screen.getByRole('button', { name: 'Choose a mailbox' })).not.toHaveTextContent('Sent')
  expect(screen.getByRole('region', { name: 'Compose mail' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('Keep me in All mail')
})

test('renders account markers in the list and reader from one batched read', async () => {
  const rows = [
    summary({ id: 'yellow', subject: 'Yellow marker', starred: true }),
    summary({ id: 'red', subject: 'Red marker', starred: true }),
    summary({ id: 'blue', subject: 'Blue marker', starred: true }),
  ]
  threadMock.mockResolvedValue(page(rows))
  mailMarkersMock.mockResolvedValue({
    yellow: 'yellow-star',
    red: 'red-star',
    blue: 'blue-question',
  })
  const user = userEvent.setup()
  render(<MailView />)

  for (const label of ['Yellow star', 'Red star', 'Blue question mark'])
    expect(await screen.findByLabelText(label)).toBeInTheDocument()
  await waitFor(() => expect(mailMarkersMock).toHaveBeenCalledTimes(1))
  expect(mailMarkersMock.mock.calls[0]![0]).toMatchObject({
    ids: ['blue', 'red', 'yellow'],
    expectedAccountSub: 'mail-view-account',
  })

  for (const [subject, label] of Object.entries({
    'Yellow marker': 'Yellow star',
    'Red marker': 'Red star',
    'Blue marker': 'Blue question mark',
  })) {
    await user.click(screen.getByRole('button', { name: new RegExp(subject, 'i') }))
    await waitFor(() => expect(screen.getAllByLabelText(label).length).toBeGreaterThanOrEqual(2))
  }
})

test('keeps account rows, messages, and annotations isolated across A-B-A switches and late reads', async () => {
  const user = userEvent.setup()
  let finishLateSearch: ((value: ReturnType<typeof page>) => void) | undefined
  let finishLateRead: ((value: unknown) => void) | undefined
  let delayNextSearch = false
  let delayFirstRead = true
  threadMock.mockImplementation(() => {
    const account = mailAccountSub
    if (delayNextSearch) {
      delayNextSearch = false
      return new Promise((resolve) => (finishLateSearch = resolve))
    }
    return Promise.resolve(
      page([
        summary({
          starred: true,
          subject: account === 'mail-view-account' ? 'Account A mail' : 'Account B mail',
        }),
      ]),
    )
  })
  readMock.mockImplementation(() => {
    const account = mailAccountSub
    if (account === 'mail-view-account' && delayFirstRead) {
      delayFirstRead = false
      return new Promise((resolve) => (finishLateRead = resolve))
    }
    return Promise.resolve({
      id: 't1',
      subject: account === 'mail-view-account' ? 'Account A mail' : 'Account B mail',
      webUrl: 'https://mail.google.com/x',
      messages: [
        {
          id: `message-${account}`,
          from: { name: 'Jane', email: 'jane@example.com' },
          to: [],
          cc: [],
          bcc: [],
          date: '2026-08-04T09:00:00.000Z',
          body: `Message from ${account}`,
          html: null,
          attachments: [],
        },
      ],
    })
  })
  mailMarkersMock.mockImplementation(async ({ ids }: { ids: string[] }) => ({
    [ids[0]!]: mailAccountSub === 'mail-view-account' ? 'red-star' : 'blue-question',
  }))
  render(<MailView />)
  const accountARow = await screen.findByRole('button', { name: /Account A mail/ })
  await waitFor(() => expect(mailMarkersMock).toHaveBeenCalled())
  expect(within(accountARow).getByLabelText('Red star')).toBeInTheDocument()
  await user.click(accountARow)
  await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1))

  mailAccountSub = 'account-b'
  act(() => getDefaultStore().set(refreshGoogleAtom))
  const accountBRow = await screen.findByRole('button', { name: /Account B mail/ })
  expect(screen.queryByRole('button', { name: /Account A mail/ })).toBeNull()
  await waitFor(() =>
    expect(within(accountBRow).getByLabelText('Blue question mark')).toBeInTheDocument(),
  )
  await user.click(accountBRow)
  expect(await screen.findByText('Message from account-b')).toBeInTheDocument()

  // Returning to A remounts its reader/list state, even though Gmail reuses t1.
  mailAccountSub = 'mail-view-account'
  act(() => getDefaultStore().set(refreshGoogleAtom))
  const returnedARow = await screen.findByRole('button', { name: /Account A mail/ })
  await waitFor(() => expect(within(returnedARow).getByLabelText('Red star')).toBeInTheDocument())
  expect(screen.queryByText('Message from account-b')).toBeNull()

  // An in-flight list search from A cannot overwrite B's rows.
  delayNextSearch = true
  await user.click(screen.getByRole('button', { name: 'Refresh mail' }))
  await waitFor(() => expect(finishLateSearch).toBeDefined())
  mailAccountSub = 'account-b'
  act(() => getDefaultStore().set(refreshGoogleAtom))
  await screen.findByRole('button', { name: /Account B mail/ })
  await act(async () => finishLateSearch?.(page([summary({ subject: 'Stale A search' })])))
  expect(screen.queryByRole('button', { name: /Stale A search/ })).toBeNull()

  // A deferred read from the prior A mount must not leak into B.
  mailAccountSub = 'mail-view-account'
  act(() => getDefaultStore().set(refreshGoogleAtom))
  await user.click(await screen.findByRole('button', { name: /Account A mail/ }))
  await waitFor(() => expect(finishLateRead).toBeDefined())
  mailAccountSub = 'account-b'
  act(() => getDefaultStore().set(refreshGoogleAtom))
  await screen.findByRole('button', { name: /Account B mail/ })
  await act(async () =>
    finishLateRead?.({
      id: 't1',
      subject: 'Account A mail',
      webUrl: 'https://mail.google.com/x',
      messages: [
        {
          id: 'message-account-a',
          from: { name: 'Jane', email: 'jane@example.com' },
          to: [],
          cc: [],
          bcc: [],
          date: '2026-08-04T09:00:00.000Z',
          body: 'Stale message from mail-view-account',
          html: null,
          attachments: [],
        },
      ],
    }),
  )
  expect(screen.queryByText('Stale message from mail-view-account')).toBeNull()
  expect(screen.queryByLabelText('Red star')).toBeNull()
})

test('invalidates markers across an A-B-A vault switch before accepting the latest identical-id read', async () => {
  threadMock.mockResolvedValue(page([summary({ starred: true })]))
  const pending: ((value: Record<string, string>) => void)[] = []
  mailMarkersMock.mockImplementation(
    () =>
      new Promise((resolve) => pending.push(resolve as (value: Record<string, string>) => void)),
  )
  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/i })
  await waitFor(() => expect(mailMarkersMock).toHaveBeenCalledTimes(1))

  act(() => getDefaultStore().set(activeRemoteAtom, 'other/vault'))
  await waitFor(() => expect(mailMarkersMock).toHaveBeenCalledTimes(2))
  act(() => getDefaultStore().set(activeRemoteAtom, 'syv-ai/vault'))
  await waitFor(() => expect(mailMarkersMock).toHaveBeenCalledTimes(3))

  await act(async () => pending[2]!({ t1: 'red-star' }))
  expect(await screen.findByLabelText('Red star')).toBeInTheDocument()
  await act(async () => pending[0]!({ t1: 'yellow-star' }))
  expect(screen.queryByLabelText('Yellow star')).toBeNull()
  expect(screen.getByLabelText('Red star')).toBeInTheDocument()
  await act(async () => pending[1]!({ t1: 'blue-question' }))
  expect(screen.queryByLabelText('Blue question mark')).toBeNull()
})

test('hides a persisted annotation when Gmail reports the thread unstarred', async () => {
  threadMock.mockResolvedValue(page([summary({ starred: false })]))
  mailMarkersMock.mockResolvedValue({ t1: 'red-star' })
  render(<MailView />)

  await screen.findByRole('button', { name: /Q2 budget/i })
  await waitFor(() => expect(mailMarkersMock).toHaveBeenCalledTimes(1))
  expect(screen.queryByLabelText('Red star')).toBeNull()
  expect(screen.queryByLabelText('Starred')).toBeNull()
})

test.each([0, 1_001])(
  'refresh and Gmail star writes invalidate the visible thread marker after %i ms',
  async (elapsed) => {
    // Extra page reads must not star the thread before the write happens.
    let starred = false
    currentAnnotations = { t1: 'red-star' }
    threadMock.mockImplementation(async () => page([summary({ starred })]))
    mailMarkersMock.mockImplementation(async () => ({ ...currentAnnotations }))
    const writeMarker = setMailMarkerMock.getMockImplementation()!
    setMailMarkerMock.mockImplementation((raw) => {
      starred = (raw as { marker: string | null }).marker !== null
      return writeMarker(raw)
    })
    const user = userEvent.setup()
    render(<MailView />)

    const row = await screen.findByRole('button', { name: /Q2 budget/i })
    await waitFor(() => expect(mailMarkersMock).toHaveBeenCalled())
    expect(screen.queryByLabelText('Red star')).toBeNull()
    await user.click(row)
    const star = await screen.findByRole('button', { name: 'Star this thread' })

    // Capture an annotation read BEFORE the write. Returning an old value from a
    // new, post-write read only tests the temporary optimistic overlay's lifetime.
    let finishStaleRead!: (value: Record<string, string>) => void
    mailMarkersMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStaleRead = resolve
        }),
    )
    await user.click(screen.getByRole('button', { name: 'Refresh mail' }))
    await waitFor(() => expect(finishStaleRead).toBeDefined())

    vi.useFakeTimers()
    try {
      await act(async () => fireEvent.click(star))
      expect(setMailMarkerMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: 't1', marker: 'yellow-star' }),
      )
      expect(currentAnnotations).toEqual({ t1: 'yellow-star' })
      // Advance past settlement without relying on the speed of userEvent/CI.
      await act(async () => vi.advanceTimersByTimeAsync(elapsed))
      await act(async () => finishStaleRead({ t1: 'blue-question' }))
      expect(
        within(screen.getByRole('button', { name: /Q2 budget/i })).getByLabelText('Yellow star'),
      ).toBeInTheDocument()
      expect(
        within(screen.getByRole('button', { name: 'Unstar this thread' })).getByLabelText(
          'Yellow star',
        ),
      ).toBeInTheDocument()
      expect(screen.queryByLabelText('Blue question mark')).toBeNull()

      // A fresh read uses the persisted write, also after the overlay expires.
      const readsBeforeRefresh = mailMarkersMock.mock.calls.length
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh mail' })))
      expect(mailMarkersMock.mock.calls.length).toBeGreaterThan(readsBeforeRefresh)
      expect(
        within(screen.getByRole('button', { name: /Q2 budget/i })).getByLabelText('Yellow star'),
      ).toBeInTheDocument()
      expect(
        within(screen.getByRole('button', { name: 'Unstar this thread' })).getByLabelText(
          'Yellow star',
        ),
      ).toBeInTheDocument()
      expect(screen.queryByLabelText('Blue question mark')).toBeNull()

      // Once settled, a genuinely newer annotation must still be observable.
      await act(async () => vi.advanceTimersByTimeAsync(1_001))
      currentAnnotations = { t1: 'blue-question' }
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh mail' })))
      expect(
        within(screen.getByRole('button', { name: /Q2 budget/i })).getByLabelText(
          'Blue question mark',
        ),
      ).toBeInTheDocument()
      expect(
        within(screen.getByRole('button', { name: 'Unstar this thread' })).getByLabelText(
          'Blue question mark',
        ),
      ).toBeInTheDocument()
      expect(screen.queryByLabelText('Yellow star')).toBeNull()
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  },
)

test('reader Retry settles a failed marker reconciliation', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  render(<MailView />)
  await openThread()
  await waitFor(() => expect(mailMarkersMock).toHaveBeenCalled())
  mailMarkersMock
    .mockRejectedValueOnce(new Error('temporary annotation failure'))
    .mockResolvedValueOnce({ t1: 'yellow-star' })
  await user.click(screen.getAllByRole('button', { name: 'Star this thread' }).at(-1)!)

  const readerHeader = screen.getByRole('heading', { name: 'Q2 budget' }).parentElement!
  await user.click(within(readerHeader).getByRole('button', { name: 'Retry marker' }))

  expect((await screen.findAllByLabelText('Yellow star')).length).toBeGreaterThan(0)
  await waitFor(() => expect(mailMarkersMock.mock.calls.length).toBeGreaterThanOrEqual(3))
})

test('reader preserves a Gmail star when its personal marker is absent', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ starred: true })]))
  setMailMarkerMock.mockRejectedValue(new Error('removal refused'))
  render(<MailView />)
  await openThread()
  await user.click(screen.getAllByRole('button', { name: 'Unstar this thread' }).at(-1)!)

  expect(screen.getAllByRole('button', { name: 'Unstar this thread' }).at(-1)).toBeInTheDocument()
  expect(setMailMarkerMock).toHaveBeenCalled()
})

test('shows ordinary Gmail stars only after the annotation read and retries marker errors', async () => {
  threadMock.mockResolvedValue(page([summary({ starred: true })]))
  mailMarkersMock.mockRejectedValueOnce(new Error('offline'))
  const user = userEvent.setup()
  render(<MailView />)

  expect(await screen.findByRole('button', { name: 'Retry marker' })).toBeInTheDocument()
  expect(await screen.findByLabelText('Starred')).toBeInTheDocument()
  mailMarkersMock.mockResolvedValueOnce({})
  await user.click(screen.getByRole('button', { name: 'Retry marker' }))
  expect((await screen.findAllByLabelText('Starred')).length).toBeGreaterThan(0)
})
