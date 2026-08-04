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
import { MailView } from '../MailView'

const threadMock = vi.fn()
const readMock = vi.fn()

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    google: {
      threads: { query: () => threadMock() },
      thread: { query: (input: { id: string }) => readMock(input) },
    },
    tasks: { create: { mutate: vi.fn() } },
  },
}))

const openExternal = vi.fn()

interface Message {
  body: string
  html: string | null
}

/** One thread in the list, one message in it — the list is not what is under
 *  test here, so every case opens the same row. */
function withMessage(message: Message) {
  threadMock.mockResolvedValue([
    {
      id: 't1',
      subject: 'Q2 budget',
      from: 'Jane',
      date: '2026-08-04T09:00:00.000Z',
      snippet: 'a snippet',
      unread: false,
      messageCount: 1,
      webUrl: 'https://mail.google.com/x',
    },
  ])
  readMock.mockResolvedValue({
    id: 't1',
    subject: 'Q2 budget',
    webUrl: 'https://mail.google.com/x',
    messages: [{ id: 'm1', from: 'Jane', to: ['nicolai@syv.ai'], date: '2026-08-04T09:00:00.000Z', ...message }],
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
  readMock.mockReset()
  openExternal.mockReset()
  // @ts-expect-error — the preload bridge is not typed onto window in tests.
  window.holi = { openExternal }
})
afterEach(() => {
  // @ts-expect-error — as above.
  delete window.holi
})

test('renders an HTML body as real markup, inside a frame of its own', async () => {
  withMessage({ body: 'Hi Nicolai, the plan is attached', html: '<p>Hi <b>Nicolai</b>, the plan is attached</p>' })

  const article = await openThread()
  const frame = await frameOf(article)

  // The point of the whole change: a designed message reads as designed mail.
  expect(frame.querySelector('b')?.textContent).toBe('Nicolai')
  // And it is emphatically NOT in the app's document.
  expect(within(article).queryByText('Nicolai')).toBeNull()
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
