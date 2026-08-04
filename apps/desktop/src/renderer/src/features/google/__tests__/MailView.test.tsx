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

test('renders an HTML body as real markup', async () => {
  withMessage({ body: 'Hi Nicolai, the plan is attached', html: '<p>Hi <b>Nicolai</b>, the plan is attached</p>' })

  const article = await openThread()

  // The point of the whole change: a designed message reads as designed mail.
  expect(within(article).getByText('Nicolai').tagName).toBe('B')
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

  // Nothing was fetched: no src at all, so no read receipt reached the sender.
  expect(article.querySelector('img')?.hasAttribute('src')).toBe(false)
  expect(within(article).getByRole('button', { name: /load images/i })).toBeInTheDocument()
})

test('loads the images when the user asks, for that message only', async () => {
  withMessage({ body: 'hello', html: '<img src="https://cdn.test/logo.png">' })
  const user = userEvent.setup()

  const article = await openThread()
  await user.click(within(article).getByRole('button', { name: /load images/i }))

  await waitFor(() =>
    expect(article.querySelector('img')?.getAttribute('src')).toBe('https://cdn.test/logo.png'),
  )
  // The offer is gone once taken — there is nothing left to unblock.
  expect(within(article).queryByRole('button', { name: /load images/i })).toBeNull()
})

test('says nothing about images when a message has none to block', async () => {
  withMessage({ body: 'hello', html: '<p>hello</p>' })

  const article = await openThread()

  expect(within(article).queryByRole('button', { name: /load images/i })).toBeNull()
})

test('opens a link in the body externally instead of navigating the app', async () => {
  withMessage({ body: 'see syv.ai', html: '<a href="https://syv.ai">syv</a>' })
  const user = userEvent.setup()

  const article = await openThread()
  await user.click(within(article).getByText('syv'))

  expect(openExternal).toHaveBeenCalledWith('https://syv.ai')
})

test('refuses to open a link scheme it does not trust', async () => {
  // DOMPurify already drops `javascript:`; this pins the second gate, because
  // the click handler is what would hand a URL to the OS.
  withMessage({ body: 'x', html: '<a href="file:///etc/passwd">local</a>' })
  const user = userEvent.setup()

  const article = await openThread()
  await user.click(within(article).getByText('local'))

  expect(openExternal).not.toHaveBeenCalled()
})
