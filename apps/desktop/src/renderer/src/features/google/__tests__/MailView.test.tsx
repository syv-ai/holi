/**
 * MailView: the list, the reader, triage, and the wiring around the sanitizer.
 *
 * The sanitizer has its own suite (`lib/__tests__/mail-html.test.tsx`); here
 * the checks are that HTML goes through it rather than around it, that blocked
 * remote content can be unblocked, and that links open externally.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MailView, matchPeople, mentionAt, replaceMention } from '../MailView'
import { getDefaultStore } from 'jotai'
import { resetMailImagesForTests } from '../../../state/mail-images'
import { resetMailFramesForTests } from '../../../state/mail-frames'
import { activeDialogAtom } from '../../../state/dialogs'

const threadMock = vi.fn()
const readMock = vi.fn()
const countsMock = vi.fn()
const contactsMock = vi.fn()
const setReadMock = vi.fn()
const setStarredMock = vi.fn()
const archiveMock = vi.fn()
const trashMock = vi.fn()
const categoryCountsMock = vi.fn()
const imageSendersMock = vi.fn()
const allowImagesFromMock = vi.fn()
const forgetImageSendersMock = vi.fn()
const sendAsMock = vi.fn()
const saveDraftMock = vi.fn()
const sendMock = vi.fn()
const discardDraftMock = vi.fn()
const draftMock = vi.fn()
const draftsMock = vi.fn()
const meetingMock = vi.fn()

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    google: {
      threads: { query: (input: unknown) => threadMock(input) },
      thread: { query: (input: { id: string }) => readMock(input) },
      mailCounts: { query: () => countsMock() },
      contacts: { query: () => contactsMock() },
      setRead: { mutate: (input: unknown) => setReadMock(input) },
      setStarred: { mutate: (input: unknown) => setStarredMock(input) },
      archive: { mutate: (input: { id: string }) => archiveMock(input) },
      trash: { mutate: (input: { id: string }) => trashMock(input) },
      categoryCounts: { query: () => categoryCountsMock() },
      imageSenders: { query: () => imageSendersMock() },
      allowImagesFrom: { mutate: (input: unknown) => allowImagesFromMock(input) },
      forgetImageSenders: { mutate: () => forgetImageSendersMock() },
      sendAs: { query: () => sendAsMock() },
      saveDraft: { mutate: (input: unknown) => saveDraftMock(input) },
      send: { mutate: (input: unknown) => sendMock(input) },
      discardDraft: { mutate: (input: unknown) => discardDraftMock(input) },
      draft: { query: (input: unknown) => draftMock(input) },
      drafts: { query: () => draftsMock() },
      meeting: { query: (input: { id: string }) => meetingMock(input) },
    },
    tasks: { create: { mutate: vi.fn() } },
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
  return await screen.findByRole('article')
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
  meetingMock.mockReset().mockResolvedValue(null)
  imageSendersMock.mockReset().mockResolvedValue([])
  allowImagesFromMock.mockReset().mockResolvedValue({ ok: true })
  forgetImageSendersMock.mockReset().mockResolvedValue({ ok: true })
  sendAsMock.mockReset().mockResolvedValue(['ada@syv.ai'])
  saveDraftMock.mockReset().mockResolvedValue({ id: 'd-1' })
  sendMock.mockReset().mockResolvedValue({ id: 'm-9' })
  discardDraftMock.mockReset().mockResolvedValue({ ok: true })
  draftMock.mockReset().mockResolvedValue(null)
  draftsMock.mockReset().mockResolvedValue([])
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
  // @ts-expect-error — as above.
  delete window.holi
})

test('shows the subject, which is the whole point of a thread list', async () => {
  // The header-request side of this is covered in google-gmail.test.ts.
  threadMock.mockResolvedValue(page([summary({ subject: 'Q2 budget', from: { name: 'Jane Doe', email: 'jane@doe.test' } })]))

  render(<MailView />)

  const row = await screen.findByRole('button', { name: /Q2 budget/ })
  expect(within(row).getByText('Q2 budget')).toBeInTheDocument()
  expect(within(row).getByText(/Jane Doe/)).toBeInTheDocument()
})

test('marks a thread the user has replied to', async () => {
  threadMock.mockResolvedValue(page([summary({ answered: true })]))

  render(<MailView />)

  expect(await screen.findByLabelText('you replied')).toBeInTheDocument()
})

test('leaves a thread awaiting the user unmarked', async () => {
  threadMock.mockResolvedValue(page([summary({ answered: false })]))

  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  expect(screen.queryByLabelText('you replied')).toBeNull()
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

  expect(await screen.findByLabelText('starred')).toBeInTheDocument()
})

test('marks a thread with an unsent draft', async () => {
  threadMock.mockResolvedValue(page([summary({ hasDraft: true })]))

  render(<MailView />)

  // You started replying and stopped.
  expect(await screen.findByLabelText('unsent draft')).toBeInTheDocument()
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

  expect(await screen.findByLabelText('meeting invite')).toBeInTheDocument()
})

test('says nothing about meetings on a thread that is not one', async () => {
  threadMock.mockResolvedValue(page([summary({ hasInvite: false })]))

  render(<MailView />)

  expect(await screen.findByText('Q2 budget')).toBeInTheDocument()
  expect(screen.queryByLabelText('meeting invite')).not.toBeInTheDocument()
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
  expect(rail!.textContent).toMatch(/\d{1,2}:\d{2}/)
  expect(rail).toHaveTextContent('(3)')
  expect(rail!.querySelector('[aria-label="meeting invite"]')).not.toBeNull()
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
  await user.click(await screen.findByRole('button', { name: /unsubscribe/i }))

  // Opened, never requested by Holi.
  expect(openExternal).toHaveBeenCalledWith('https://list.test/unsub?u=9')
})

/**
 * Joining a meeting from the reader.
 *
 * The link is NOT parsed out of the `.ics`. Main matches the invite's `UID` to
 * the calendar event and hands back that event's `conferenceUrl`, so
 * "where is the video call" has one implementation, in `calendar.ts`.
 */
const MEETING = {
  eventId: 'e1',
  title: 'Sprint review',
  start: '2026-08-19T12:00:00.000Z',
  end: '2026-08-19T13:00:00.000Z',
  conferenceUrl: 'https://teams.microsoft.com/l/meetup-join/19%3aX/0',
  htmlLink: 'https://calendar.google.com/event?eid=e1',
}

test('joins the meeting a thread is about', async () => {
  withMessage({ body: 'are you free at 14:00?', html: null })
  threadMock.mockResolvedValue(page([summary({ hasInvite: true })]))
  meetingMock.mockResolvedValue(MEETING)
  const user = userEvent.setup()

  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await user.click(await screen.findByRole('button', { name: /join/i }))

  expect(meetingMock).toHaveBeenCalledWith({ id: 't1' })
  expect(openExternal).toHaveBeenCalledWith(MEETING.conferenceUrl)
})

test('spends nothing looking for a meeting in a thread that has no invite', async () => {
  withMessage({ body: 'lunch?', html: null })
  threadMock.mockResolvedValue(page([summary({ hasInvite: false })]))
  const user = userEvent.setup()

  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))

  // The summary already says there is no `.ics`.
  expect(meetingMock).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: /join/i })).not.toBeInTheDocument()
})

/**
 * A meeting with no video call: the event is still worth reaching, but not
 * through a Join button.
 */
test('offers the calendar page when there is nothing to join', async () => {
  withMessage({ body: 'in the kitchen', html: null })
  threadMock.mockResolvedValue(page([summary({ hasInvite: true })]))
  meetingMock.mockResolvedValue({ ...MEETING, conferenceUrl: null })
  const user = userEvent.setup()

  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await user.click(await screen.findByRole('button', { name: /open this meeting/i }))

  expect(screen.queryByRole('button', { name: /join/i })).not.toBeInTheDocument()
  expect(openExternal).toHaveBeenCalledWith(MEETING.htmlLink)
})

test('says nothing when the invite is not on the calendar', async () => {
  withMessage({ body: 'are you free at 14:00?', html: null })
  threadMock.mockResolvedValue(page([summary({ hasInvite: true })]))
  meetingMock.mockResolvedValue(null)
  const user = userEvent.setup()

  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))

  await waitFor(() => expect(meetingMock).toHaveBeenCalled())
  // Declined, or already over: nothing to join.
  expect(screen.queryByRole('button', { name: /join/i })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /open this meeting/i })).not.toBeInTheDocument()
})

/**
 * The race: open an invite, then open something else before the lookup lands.
 * Without keying the answer to the thread it was asked about, the second thread
 * inherits the first one's Join button.
 */
test('does not offer one thread’s meeting on another thread', async () => {
  readMock.mockImplementation(async ({ id }: { id: string }) => ({
    id,
    subject: id === 't1' ? 'Q2 budget' : 'Lunch',
    webUrl: 'https://mail.google.com/x',
    messages: [
      {
        id: `m-${id}`,
        from: { name: 'Ada Holm', email: 'ada@syv.ai' },
        to: [],
        cc: [],
        bcc: [],
        date: '2026-08-04T09:00:00.000Z',
        attachments: [],
        body: 'hello',
        html: null,
      },
    ],
  }))
  threadMock.mockResolvedValue(
    page([
      summary({ id: 't1', subject: 'Q2 budget', hasInvite: true }),
      summary({ id: 't2', subject: 'Lunch', hasInvite: false }),
    ]),
  )
  meetingMock.mockResolvedValue(MEETING)
  const user = userEvent.setup()

  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await waitFor(() => expect(screen.getByRole('button', { name: /join/i })).toBeInTheDocument())
  await user.click(screen.getByRole('button', { name: /Lunch/ }))

  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /join/i })).not.toBeInTheDocument(),
  )
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

test('lists attachments on an open message', async () => {
  withMessage(
    { body: 'see attached', html: null },
    { attachments: [{ filename: 'q2-deck.pdf', mimeType: 'application/pdf', size: 482_113 }] },
  )

  const article = await openThread()

  expect(within(article).getByText('q2-deck.pdf')).toBeInTheDocument()
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
  // vault at all (`usePanelLayout` cannot key a write on a null remote).
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
  expect(screen.getByRole('button', { name: /collapse message 2 of 2 from Mette/i })).toBeInTheDocument()

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
 * Triage (D68): opening spends a request only when there is something to
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

  await waitFor(() => expect(setReadMock).toHaveBeenCalledWith({ id: 't1', read: true }))
  expect(setReadMock).toHaveBeenCalledTimes(1)
  // Locally, with no second `threads.query`.
  await waitFor(() => expect(rowIsUnread(screen.getByRole('button', { name: /Q2 budget/ }))).toBe(false))
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
  await waitFor(() => expect(rowIsUnread(screen.getByRole('button', { name: /Q2 budget/ }))).toBe(true))
})

test('stars and unstars the open thread', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ starred: false })]))
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')

  await user.click(screen.getByRole('button', { name: 'star this thread' }))

  await waitFor(() => expect(setStarredMock).toHaveBeenCalledWith({ id: 't1', starred: true }))
  // The button becomes its own inverse.
  const unstar = await screen.findByRole('button', { name: 'unstar this thread' })
  await user.click(unstar)
  await waitFor(() => expect(setStarredMock).toHaveBeenLastCalledWith({ id: 't1', starred: false }))
})

test('archiving removes the row and closes the reader', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary(), { ...summary(), id: 't2', subject: 'Other' }]))
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')

  await user.click(screen.getByRole('button', { name: 'archive this thread' }))

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

  await user.click(screen.getByRole('button', { name: 'move this thread to trash' }))

  await waitFor(() => expect(trashMock).toHaveBeenCalledWith({ id: 't1' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: /Q2 budget/ })).toBeNull())
})

test('a refused archive puts the thread back in the list', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  archiveMock.mockRejectedValue(new Error('this Google permission was not granted'))
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')

  await user.click(screen.getByRole('button', { name: 'archive this thread' }))

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

  await user.click(screen.getByRole('button', { name: 'archive this thread' }))

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

  await waitFor(() => expect(allowImagesFromMock).toHaveBeenCalledWith({ sender: 'jane@example.com' }))
  // And it takes effect now, not on the next launch.
  expect(within(article).queryByRole('button', { name: /^load images$/i })).toBeNull()
})

test('a sender already allowed never shows the banner at all', async () => {
  imageSendersMock.mockResolvedValue(['jane@example.com'])
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

/**
 * The canvas a message renders on.
 *
 * Mail declares its ink and inherits its paper (see `canvasFor`), so a message
 * that brings any design of its own gets white.
 */
test('a designed message renders on paper, not on the dark theme', async () => {
  withMessage({ body: 'hello', html: '<p style="color:#333333">the quarterly plan</p>' })

  const article = await openThread()
  const frame = await frameOf(article)

  const style = frame.querySelector('style')?.textContent ?? ''
  expect(style).toContain('background: #ffffff')
  expect(style).toContain('color-scheme: light')
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

  await user.click(screen.getByRole('button', { name: 'choose a mailbox' }))

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

  await user.click(screen.getByRole('button', { name: 'choose a mailbox' }))

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
  await user.click(screen.getByRole('button', { name: 'refresh mail' }))
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

  await user.click(screen.getByRole('button', { name: 'close find' }))

  await waitFor(() =>
    expect(document.querySelectorAll('[data-holi-find]')).toHaveLength(0),
  )
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
  await user.click(await screen.findByRole('button', { name: 'archive' }))

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
  expect(screen.queryByRole('button', { name: 'refresh mail' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'choose a mailbox' })).toBeNull()

  await user.click(screen.getByRole('button', { name: 'clear selection' }))

  expect(await screen.findByRole('button', { name: 'refresh mail' })).toBeInTheDocument()
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
  await user.click(screen.getByRole('button', { name: 'clear selection' }))
  await user.click(await screen.findByRole('button', { name: 'refresh mail' }))
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
async function openRowMenu(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
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

  await waitFor(() => expect(setReadMock).toHaveBeenCalledWith({ id: 't1', read: false }))
})

test('offers Unsubscribe only when the sender advertised one', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()
  render(<MailView />)

  expect(within(await openRowMenu(user)).queryByRole('menuitem', { name: 'Unsubscribe' })).toBeNull()
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

  await user.click(screen.getByRole('button', { name: 'choose a mailbox' }))

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
  expect(screen.getByRole('button', { name: 'choose a mailbox' })).toHaveTextContent('Sent')
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

  const compose = screen.getByRole('button', { name: 'new message' })
  const refresh = screen.getByRole('button', { name: 'refresh mail' })

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
  await user.click(screen.getByRole('button', { name: 'refresh mail' }))
  await screen.findByRole('button', { name: /Newer thing/ })

  refuse(new Error('this Google permission was not granted'))

  // The stale snapshot must not come back.
  expect(await screen.findByText(/Reconnect Google in settings/)).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: /Newer thing/ })).toBeInTheDocument())
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

  await user.click(screen.getByRole('button', { name: 'archive this thread' }))

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

  await user.click(screen.getByRole('button', { name: 'archive this thread' }))

  expect(await screen.findByText(/rate limiting/)).toBeInTheDocument()
  expect(screen.queryByText(/Reconnect Google/)).toBeNull()
})

test('unblocking builds a NEW frame, because a document cannot shed a CSP', async () => {
  // A `<meta>` CSP joins the document's list of policies, and `document.open()`
  // does not clear the ones already applied, so rewriting the document with a
  // wider `img-src` leaves the images blocked. Only a new iframe drops a policy.
  //
  // jsdom does not enforce CSP, so this asserts the element is replaced.
  withMessage({ body: 'hello', html: '<img src="https://cdn.test/logo.png">' })
  const user = userEvent.setup()

  const article = await openThread()
  const before = article.querySelector('iframe')
  await frameOf(article)

  await user.click(within(article).getByRole('button', { name: /^load images$/i }))

  await waitFor(() => expect(article.querySelector('iframe')).not.toBe(before))
  expect((await frameOf(article)).querySelector('img')?.getAttribute('src')).toBe(
    'https://cdn.test/logo.png',
  )
})

test('“always from this sender” rebuilds the frame too, not just the banner', async () => {
  // The iframe is keyed on the policy flag; the standing path must take the
  // same route, since it reaches `allowRemoteContent` through a different atom.
  withMessage({ body: 'hello', html: '<img src="https://cdn.test/logo.png">' })
  const user = userEvent.setup()

  const article = await openThread()
  const before = article.querySelector('iframe')
  await frameOf(article)

  await user.click(within(article).getByRole('button', { name: /always from this sender/i }))

  await waitFor(() => expect(article.querySelector('iframe')).not.toBe(before))
  expect((await frameOf(article)).querySelector('img')?.getAttribute('src')).toBe(
    'https://cdn.test/logo.png',
  )
})

test('does not churn the frame when nothing about the policy changed', async () => {
  // The key is the flag, not a fresh value per render, which would rebuild the
  // document every render and lose scroll position.
  withMessage({ body: 'hello', html: '<p>just a sentence</p>' })

  const article = await openThread()
  const first = article.querySelector('iframe')
  await frameOf(article)

  expect(article.querySelector('iframe')).toBe(first)
})

/**
 * Replying without leaving (D71).
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

test('reply opens a composer inside the thread, not a browser', async () => {
  const user = await openForCompose()

  await user.click(await screen.findByRole('button', { name: 'reply' }))

  const composer = await screen.findByRole('region', { name: 'Compose mail' })
  expect(composer).toBeInTheDocument()
  // The thing being replied to is still on screen. Scoped to the READER's copy:
  // the composer's quote puts `>` in its own span, so its text is 'a body' too.
  expect(screen.getByText('a body', { selector: '[data-holi-message]' })).toBeInTheDocument()
  expect(openExternal).not.toHaveBeenCalled()
})

test('reply addresses the sender; reply-all copies the rest', async () => {
  const user = await openForCompose()

  await user.click(await screen.findByRole('button', { name: 'reply' }))

  const chips = await screen.findAllByTestId('chip-name')
  expect(chips.map((c) => c.textContent)).toEqual(['Jane'])
})

test('forward opens with no recipients at all', async () => {
  const user = await openForCompose()

  await user.click(await screen.findByRole('button', { name: 'forward' }))

  await screen.findByRole('region', { name: 'Compose mail' })
  expect(screen.queryAllByTestId('chip-name')).toEqual([])
})

test('switching from reply to forward rebuilds the composer', async () => {
  // `composeFrom` runs once, on mount. Without a remount the second intent
  // would open showing the first one's recipients.
  const user = await openForCompose()
  await user.click(await screen.findByRole('button', { name: 'reply' }))
  expect((await screen.findAllByTestId('chip-name')).length).toBe(1)

  await user.click(screen.getByRole('button', { name: 'forward' }))

  await screen.findByRole('region', { name: 'Compose mail' })
  expect(screen.queryAllByTestId('chip-name')).toEqual([])
})

test('sending closes the composer and refetches the thread', async () => {
  const user = await openForCompose()
  await user.click(await screen.findByRole('button', { name: 'reply' }))
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
  await user.click(await screen.findByRole('button', { name: 'reply' }))

  await user.click(await screen.findByRole('button', { name: 'Send' }))

  await waitFor(() => expect(screen.getByText('no network')).toBeVisible())
  expect(screen.getByRole('region', { name: 'Compose mail' })).toBeInTheDocument()
})

test('open in Gmail is still there — leaving is a choice, not a fallback', async () => {
  const user = await openForCompose()

  await user.click(await screen.findByRole('button', { name: 'open in Gmail' }))

  expect(openExternal).toHaveBeenCalledWith('https://mail.google.com/x')
})

/**
 * The Drafts view (D71).
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
  expect(draftMock).toHaveBeenCalledWith({ id: 'd-1' })
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

  expect(await screen.findByText('No drafts.')).toBeInTheDocument()
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

  await user.click(await screen.findByRole('button', { name: 'continue draft' }))

  await waitFor(() => expect(draftMock).toHaveBeenCalledWith({ id: 'new' }))
})

test('no Continue draft on a thread that has none', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ hasDraft: false })]))
  render(<MailView />)

  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))

  await screen.findByRole('article')
  expect(screen.queryByRole('button', { name: 'continue draft' })).toBeNull()
})

test('the thread list comes back when Mail is chosen again', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  render(<MailView />)
  await chooseMailbox(user, 'Drafts')
  await screen.findByText('No drafts.')

  await chooseMailbox(user, /^All mail/)

  expect(await screen.findByRole('button', { name: /Q2 budget/ })).toBeInTheDocument()
})

/**
 * A new message (D71).
 *
 * A dialog, where a reply is inline: a fresh message has no context to
 * preserve.
 */
test('new message opens the compose dialog rather than an inline composer', async () => {
  // Asserted against the real registry atom: the entry IS the contract with
  // `DialogHost`.
  const store = getDefaultStore()
  store.set(activeDialogAtom, null)
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  render(<MailView />)

  await user.click(await screen.findByRole('button', { name: 'new message' }))

  expect(store.get(activeDialogAtom)).toEqual({ id: 'compose-mail', size: 'lg' })
})

test('new message does not disturb an open thread', async () => {
  // The dialog must not close what is being read behind it.
  const store = getDefaultStore()
  store.set(activeDialogAtom, null)
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary()]))
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await screen.findByRole('article')

  await user.click(screen.getByRole('button', { name: 'new message' }))

  expect(screen.getByRole('article')).toBeInTheDocument()
})
