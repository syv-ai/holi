/**
 * MailView — the reader, at the point where a message body becomes markup.
 *
 * The sanitizer has its own suite (`lib/__tests__/mail-html.test.tsx`); what is
 * tested here is the wiring around it, which is where the safety property is
 * actually spent: that HTML goes through `sanitizeMailHtml` rather than around
 * it, that a blocked message offers the unblock and that the unblock works, and
 * that a link in a message opens externally instead of navigating the app.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MailView, matchPeople, mentionAt, replaceMention } from '../MailView'

const threadMock = vi.fn()
const readMock = vi.fn()
const countsMock = vi.fn()
const contactsMock = vi.fn()
const markReadMock = vi.fn()
const setStarredMock = vi.fn()
const archiveMock = vi.fn()
const trashMock = vi.fn()

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    google: {
      threads: { query: (input: unknown) => threadMock(input) },
      thread: { query: (input: { id: string }) => readMock(input) },
      mailCounts: { query: () => countsMock() },
      contacts: { query: () => contactsMock() },
      markRead: { mutate: (input: { id: string }) => markReadMock(input) },
      setStarred: { mutate: (input: unknown) => setStarredMock(input) },
      archive: { mutate: (input: { id: string }) => archiveMock(input) },
      trash: { mutate: (input: { id: string }) => trashMock(input) },
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
    unsubscribeUrl: null,
    ...overrides,
  }
}

/** Gmail answers a page at a time; `nextPageToken` is null at the end. */
function page(threads: unknown[], nextPageToken: string | null = null) {
  return { threads, nextPageToken, syncedAt: new Date().toISOString() }
}

/** One thread in the list, one message in it — the list is not what is under
 *  test here, so every case opens the same row. */
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
        to: [{ name: 'Nicolai', email: 'nicolai@syv.ai' }],
        cc: [],
        date: '2026-08-04T09:00:00.000Z',
        attachments: [],
        ...message,
        ...extra,
      },
    ],
  })
}

/** Mount, open the one thread, and hand back the reader pane. */
async function openThread(): Promise<HTMLElement> {
  const user = userEvent.setup()
  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  return await screen.findByRole('article')
}

/**
 * The message's own document — an HTML body renders in a sandboxed frame, so
 * everything about how it rendered is *inside* the frame and deliberately not
 * reachable from the app's own DOM.
 */
async function frameOf(article: HTMLElement): Promise<Document> {
  const frame = article.querySelector('iframe')
  expect(frame, 'an HTML body must render in a frame').not.toBeNull()
  await waitFor(() => expect(frame!.contentDocument?.body.firstChild).toBeTruthy())
  return frame!.contentDocument!
}

beforeEach(() => {
  threadMock.mockReset()
  // A default, because the real `trpc.google.thread.query` ALWAYS returns a
  // promise. A bare `mockReset()` returned `undefined`, and every test that
  // opened a row without stubbing this threw "Cannot read properties of
  // undefined (reading 'then')" — which vitest reports as an unhandled error
  // beside a passing suite rather than as a failure. The double has to keep the
  // shape of the thing it stands in for.
  readMock.mockReset().mockResolvedValue({
    id: 't1',
    subject: 'Q2 budget',
    webUrl: 'https://mail.google.com/x',
    messages: [
      {
        id: 'm1',
        from: { name: 'Jane', email: 'jane@example.com' },
        to: [{ name: 'Nicolai', email: 'nicolai@syv.ai' }],
        cc: [],
        date: '2026-08-04T09:00:00.000Z',
        attachments: [],
        body: 'a body',
        html: null,
      },
    ],
  })
  countsMock.mockReset().mockResolvedValue({ unread: 3, total: 120 })
  contactsMock.mockReset().mockResolvedValue([])
  markReadMock.mockReset().mockResolvedValue({ ok: true })
  setStarredMock.mockReset().mockResolvedValue({ ok: true })
  archiveMock.mockReset().mockResolvedValue({ ok: true })
  trashMock.mockReset().mockResolvedValue({ ok: true })
  openExternal.mockReset()
  // @ts-expect-error — the preload bridge is not typed onto window in tests.
  window.holi = { openExternal }
})
afterEach(() => {
  // @ts-expect-error — as above.
  delete window.holi
})

test('shows the subject, which is the whole point of a thread list', async () => {
  // Regression: every row read "(no subject)" from an empty sender, because the
  // metadata headers were requested as one comma-joined value that Gmail
  // matched nothing against and answered 200 to. See google-gmail.test.ts.
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

/**
 * The list, past "a row per thread".
 *
 * An inbox that shows everything at once is the inbox Gmail's own tabs exist
 * to fix, and a list that stops at 25 with no way forward is a list that hides
 * the rest of the mail.
 */

test('shows the whole inbox by default, not one of Gmail’s tabs', async () => {
  threadMock.mockResolvedValue(page([summary()]))

  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  // Regression, reported from real use as "Email view says No threads".
  // `category:primary` only matches anything if the account USES Gmail's tabs,
  // and any non-Default inbox layout switches them off. Defaulting to a filter
  // that can silently empty the inbox is the wrong default: the tabs are
  // offered, not assumed.
  expect(queryOf(0).category).toBeUndefined()
})

test('a search is not narrowed by the category, as in Gmail itself', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()

  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /choose a category/i }))
  await user.click(await screen.findByRole('menuitem', { name: /promotions/i }))
  await waitFor(() => expect(queryOf(1)).toMatchObject({ category: 'promotions' }))

  // Search is an icon until asked for; opening it focuses the field.
  await user.click(screen.getByRole('button', { name: /search mail/i }))
  await user.type(await screen.findByRole('combobox', { name: /search mail/i }), 'from:jane{Enter}')

  // Gmail's own search escapes the tab you are standing in. Silently ANDing the
  // category onto an explicit query is how a search comes back empty for a
  // reason the user cannot see.
  await waitFor(() => expect(queryOf(2)).toMatchObject({ query: 'from:jane' }))
  expect(queryOf(2).category).toBeUndefined()
})

test('says which tab is empty, rather than implying the inbox is', async () => {
  threadMock.mockResolvedValue(page([]))
  const user = userEvent.setup()

  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /choose a category/i }))
  await user.click(await screen.findByRole('menuitem', { name: /promotions/i }))

  // An empty tab and an empty mailbox look identical otherwise — which is
  // exactly how the Primary default read as "the mail is gone".
  expect(await screen.findByText(/nothing in promotions/i)).toBeInTheDocument()
})

test('lets the user look at Promotions', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()

  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /choose a category/i }))
  await user.click(await screen.findByRole('menuitem', { name: /promotions/i }))

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

  // The state nothing else in the list reveals: you started replying, stopped,
  // and there is no other trace of it.
  expect(await screen.findByLabelText('unsent draft')).toBeInTheDocument()
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

  // Opened, never requested by Holi: an unsubscribe URL is a page to look at,
  // and firing it silently is a request made on the user's behalf.
  expect(openExternal).toHaveBeenCalledWith('https://list.test/unsub?u=9')
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
  // Appended, not replaced — "load more" that loses the page above it is a
  // pagination control pretending to be one.
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

  // The scope is read-only and v1 does not download: the honest affordance is
  // the thread in Gmail, where the attachment actually is.
  expect(openExternal).toHaveBeenCalledWith('https://mail.google.com/x')
})

test('renders an HTML body as real markup, inside a frame of its own', async () => {
  // A word that appears ONLY in the body. The recipient's name would otherwise
  // satisfy the second assertion by accident — the header renders it as a link.
  withMessage({
    body: 'the quarterly plan is attached',
    html: '<p>the <b>quarterly</b> plan is attached</p>',
  })

  const article = await openThread()
  const frame = await frameOf(article)

  // The point of the whole change: a designed message reads as designed mail.
  expect(frame.querySelector('b')?.textContent).toBe('quarterly')
  // And it is emphatically NOT in the app's document.
  expect(within(article).queryByText(/quarterly/)).toBeNull()
})

test('the frame is sandboxed without allow-scripts', async () => {
  // Granting `allow-scripts` alongside `allow-same-origin` would let framed
  // content remove its own sandbox — the one combination that must never ship.
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
  // parsed — this is the path where there is no sanitizer to save us.
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
  // Belt and braces — the frame's own policy would refuse the fetch anyway.
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
  // The frame's policy has to widen with it, or the src would be there and the
  // image still would not load.
  expect(
    (await frameOf(article))
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content'),
  ).toContain('https:')
  // The offer is gone once taken — there is nothing left to unblock.
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
  // Left to itself the frame would navigate to the page in place — which is
  // precisely the remote content the whole feature keeps out.
  expect(notCancelled).toBe(false)
})

test('refuses to open a link scheme it does not trust, and still does not navigate', async () => {
  // `ftp:` on purpose, not `javascript:` or `file:` — DOMPurify strips those,
  // so a test using them would pass without the second gate existing. This one
  // survives sanitization and is refused here, at the point where a URL would
  // actually leave the app.
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
 * The width itself is not assertable — `react-resizable-panels` sizes from
 * measured geometry and jsdom measures none. What these check is the wiring
 * either side of the measurement: that there is a handle to drag at all
 * (the list was a fixed `w-80` before), and that a width already saved reaches
 * the panel rather than being read from a per-vault store mail never writes to.
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
  // vault at all — so the split is filed under the account. The per-vault store
  // would remember a different width per vault for identical content, and would
  // decline to save anything at all until a vault exists (`usePanelLayout`
  // cannot key a write on a null remote).
  expect(keys).toContain('holi:panelLayouts:global')
  expect(keys).not.toContain('holi:panelLayouts')
})

/**
 * The toolbar.
 *
 * One row, no heading. Search is an icon until it is wanted, because a
 * permanently-open field in a panel this narrow spends a whole row on a control
 * used occasionally — and the list is what the pane is for.
 */

test('search is an icon until it is asked for', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()

  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  expect(screen.queryByRole('combobox', { name: /search mail/i })).toBeNull()

  await user.click(screen.getByRole('button', { name: /search mail/i }))

  const field = await screen.findByRole('combobox', { name: /search mail/i })
  // Focused on unfold: the click that opened it is the same gesture as the
  // intent to type, and a field that looks ready but is not is worse than none.
  expect(field).toHaveFocus()
})

test('⌘F opens search when the pane has focus', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  const user = userEvent.setup()

  render(<MailView />)
  // Focus something inside the pane — the binding is deliberately scoped to the
  // pane rather than the document, so mail's ⌘F cannot fire from the editor.
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await user.keyboard('{Meta>}f{/Meta}')

  expect(await screen.findByRole('combobox', { name: /search mail/i })).toBeInTheDocument()
})

test('the view carries no redundant "Mail" heading', async () => {
  threadMock.mockResolvedValue(page([summary()]))

  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  // The tab already says Mail. A title inside a pane that is already labelled
  // spends the narrowest dimension of the narrowest panel on a word nobody
  // reads twice.
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

  // Unlike a category, unread is a STATE rather than a place — so a search
  // keeps it, where a search deliberately escapes the category tab.
  await waitFor(() => expect(queryOf(2)).toMatchObject({ query: 'budget', unread: true }))
})

test('the footer reports sync and Gmail’s own exact counts', async () => {
  threadMock.mockResolvedValue(page([summary()]))
  countsMock.mockResolvedValue({ unread: 7, total: 431 })

  render(<MailView />)
  await screen.findByRole('button', { name: /Q2 budget/ })

  // Exact, from labels.get — not the resultSizeEstimate the category picker
  // refuses to show, which is approximate and so would be a number people
  // trust and it would be wrong.
  expect(await screen.findByText(/7 unread · 431 in inbox/)).toBeInTheDocument()
  expect(screen.getByText(/synced/i)).toBeInTheDocument()
})

test('the footer counts only what is on screen when Gmail will not say', async () => {
  threadMock.mockResolvedValue(page([summary(), summary({ id: 't2', subject: 'Q3 plan' })]))
  countsMock.mockResolvedValue(null)

  render(<MailView />)
  await screen.findByRole('button', { name: /Q3 plan/ })

  // "0 unread" would be a claim. A count of what is rendered cannot be wrong.
  expect(await screen.findByText(/2 shown/)).toBeInTheDocument()
})

/**
 * The reader.
 *
 * A thread is one scrolling column of messages, each at its full height. The
 * history above the newest message is context you open when you want it.
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

  // A ten-message thread that opens fully expanded buries the part that is new.
  const older = await screen.findByRole('button', { name: /expand message from Jane/i })
  expect(screen.getByRole('button', { name: /collapse message from Mette/i })).toBeInTheDocument()

  await user.click(older)
  expect(
    await screen.findByRole('button', { name: /collapse message from Jane/i }),
  ).toBeInTheDocument()
})

test('an address is a person you can act on, not just a name', async () => {
  withMessage({ body: 'hello', html: null })
  const user = userEvent.setup()

  render(<MailView />)
  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))
  await user.click(await screen.findByRole('button', { name: /about Jane/i }))

  // The address is the whole reason main stopped throwing it away: a display
  // name cannot be mailed, copied, or told apart from a namesake.
  expect(await screen.findByText('jane@example.com')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: /^email$/i }))

  // Composing is a mailto: handoff — the granted scope is read-only, so the
  // OS's mail client sends and Holi does not pretend it can.
  expect(openExternal).toHaveBeenCalledWith('mailto:jane@example.com')
})

/**
 * "@" completion.
 *
 * The people come from the mail already in hand — there is no contacts scope
 * (`GOOGLE_SCOPES` is gmail + calendar, both read-only), so an address book
 * would mean a new Google API and a fresh consent screen. What the cache can
 * see is everyone who has written to you, which is most of who anyone searches
 * for. These are the pure parts, tested directly rather than through the field.
 */

test('an @ only opens the list while it is still one word', () => {
  expect(mentionAt('from:@met')).toEqual({ start: 5, term: 'met' })
  expect(mentionAt('@')).toEqual({ start: 0, term: '' })
  // Whitespace ends it: `@` in prose is not a request for a person.
  expect(mentionAt('@met budget')).toBeNull()
  // And an address the user already accepted must not reopen the list on its
  // own `@` — this is what made the popup flicker back after every completion.
  expect(mentionAt('from:jane@syv.ai')).toBeNull()
  expect(mentionAt('budget')).toBeNull()
})

test('accepting a person leaves a query the user could have typed', () => {
  const query = 'from:@met'
  expect(replaceMention(query, mentionAt(query)!, 'mette@syv.ai')).toBe('from:mette@syv.ai ')

  // Gmail's own grammar either way — a bare `@mette` is not valid, so the
  // prefix is supplied when the user has not already written one.
  const bare = '@met'
  expect(replaceMention(bare, mentionAt(bare)!, 'mette@syv.ai')).toBe('from:mette@syv.ai ')
})

test('people are ranked by how often you actually hear from them', () => {
  const threads = [
    { from: { name: 'Mette Nielsen', email: 'mette@syv.ai' } },
    { from: { name: 'Mette Nielsen', email: 'mette@syv.ai' } },
    { from: { name: 'Anders Skøt', email: 'anders@krifa.dk' } },
    // No address to act on — a `From` the parser could not read. Never offered,
    // because completing to an empty address produces a query matching nothing.
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
    // Someone who has not written recently — the whole reason to want contacts.
    { name: 'Signe Holm', email: 'signe@syv.ai' },
    // The same person as the sender above, as the address book has them.
    { name: 'Mette N.', email: 'mette@syv.ai' },
  ]

  const all = matchPeople(threads, '', contacts)

  // Whoever actually writes to you outranks the address book, which carries no
  // frequency to rank on.
  expect(all.map((p) => p.email)).toEqual(['mette@syv.ai', 'signe@syv.ai'])
  // Not duplicated, and the sender's own count survives — a contact must not
  // flatten someone already ranked to zero.
  expect(all[0]!.count).toBe(1)
  expect(all[0]!.name).toBe('Mette Nielsen')
})

test('no contacts is not a broken dropdown — the sender corpus still answers', () => {
  // What a cold contacts API, a refusal, or a grant predating contacts.readonly
  // all look like here. Completion has to keep working.
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
 * Triage (D68) — the first stateful things Holi does to a mailbox.
 *
 * What matters here is the *wiring*, which is the half jsdom can prove: that
 * opening spends a request only when there is something to change, that the row
 * moves without a refetch, and that a refusal puts the row back. Whether the
 * buttons land where a person expects them is layout, and this file cannot see
 * layout at all.
 */

/** The row's name span carries the unread weight — see `ThreadRow`. */
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

  await waitFor(() => expect(markReadMock).toHaveBeenCalledWith({ id: 't1' }))
  expect(markReadMock).toHaveBeenCalledTimes(1)
  // Locally, with no second `threads.query`. A refetch would spend the whole
  // saving `history.list` exists for.
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
  expect(markReadMock).not.toHaveBeenCalled()
})

test('a refused mark-read puts the row back to unread', async () => {
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ unread: true })]))
  markReadMock.mockRejectedValue(new Error('this Google permission was not granted'))
  render(<MailView />)

  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))

  await waitFor(() => expect(markReadMock).toHaveBeenCalled())
  // The optimistic clear is undone: the mailbox still says unread, so the list
  // must too. This is the exact state a grant older than GOOGLE_SCOPES produces.
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
  // The button becomes its own inverse, so the state is legible without a legend.
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
  // Both halves. Leaving the reader open on a thread that has left the list is
  // how `openSummary` keeps rendering something the mailbox no longer holds.
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
  // Still there. An optimistic removal that is never undone loses mail from the
  // list until a full refresh, and the user has no reason to suspect one.
  await waitFor(() => expect(screen.getByRole('button', { name: /Q2 budget/ })).toBeInTheDocument())
})

test('a refused write says why, instead of silently snapping back', async () => {
  // The failure mode this exists for, from real use: a grant without
  // gmail.modify loads mail perfectly and refuses every write. The revert put
  // the row back exactly as it was, which is indistinguishable from the click
  // never registering — so the symptom was "nothing happens" and the fix
  // (reconnect) was unguessable.
  const user = userEvent.setup()
  threadMock.mockResolvedValue(page([summary({ unread: true })]))
  markReadMock.mockRejectedValue(new Error('this Google permission was not granted'))
  render(<MailView />)

  await user.click(await screen.findByRole('button', { name: /Q2 budget/ }))

  expect(await screen.findByText(/Reconnect Google in settings/)).toBeInTheDocument()
})

test('a rate limit is not reported as a permissions problem', async () => {
  // Sending someone to re-consent for a transient throttle is the wrong-fix
  // problem `classify` exists to avoid in main; it must survive the trip here.
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
