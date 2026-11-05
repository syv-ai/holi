import { describe, expect, it, vi } from 'vitest'
import {
  extractLoginSecret,
  findLoginSecret,
  waitForLoginSecret,
  type MailLookup,
} from '../main/login-mail'

const HOST = 'booking.example.test'
const LINK = `https://${HOST}/auth/v1/verify?token=pkce_abc&type=magiclink&redirect_to=https://${HOST}/callback`

describe('the login email', () => {
  it('takes the site’s verify link out of the HTML, unescaping it', () => {
    const html = `<a href="${LINK.replace(/&/g, '&amp;')}">Log In</a>`
    expect(extractLoginSecret({ body: '', html }, HOST)).toEqual({ link: LINK })
  })

  it('ignores links to any other host, however they are worded', () => {
    const body = `Log in: https://${HOST}.evil.test/auth/v1/verify?token=x and https://evil.test/callback?code=1`
    expect(extractLoginSecret({ body, html: null }, HOST)).toBeNull()
  })

  it('ignores the site’s other links', () => {
    expect(
      extractLoginSecret({ body: `See https://${HOST}/bookings/new`, html: null }, HOST),
    ).toBeNull()
  })

  it('falls back to a one-time code', () => {
    expect(extractLoginSecret({ body: 'Your login code is: 482913', html: null }, HOST)).toEqual({
      code: '482913',
    })
  })

  it('reads only mail that arrived after the request', async () => {
    const sent = Date.parse('2026-11-04T12:00:00Z')
    const mail: MailLookup = {
      search: async () => [
        { id: 'old', date: '2026-11-04T10:00:00Z' },
        { id: 'new', date: '2026-11-04T12:00:20Z' },
      ],
      messages: vi.fn(async (id: string) => [
        {
          date: id === 'new' ? '2026-11-04T12:00:20Z' : '2026-11-04T10:00:00Z',
          body: LINK,
          html: null,
        },
      ]),
    }
    expect(await findLoginSecret(mail, HOST, sent)).toEqual({ link: LINK })
    expect(mail.messages).toHaveBeenCalledTimes(1)
    expect(mail.messages).toHaveBeenCalledWith('new')
  })

  it('polls until the email arrives, and gives up when told', async () => {
    let polls = 0
    const mail: MailLookup = {
      search: async () => (++polls >= 3 ? [{ id: 't', date: new Date().toISOString() }] : []),
      messages: async () => [{ date: new Date().toISOString(), body: LINK, html: null }],
    }
    const sleep = vi.fn(async () => {})
    const opts = { intervalMs: 1_000, sleep, stop: () => false }
    expect(await waitForLoginSecret(mail, HOST, Date.now(), opts)).toEqual({ link: LINK })
    expect(polls).toBe(3)

    const never: MailLookup = { search: async () => [], messages: async () => [] }
    const stop = () => sleep.mock.calls.length >= 5
    expect(await waitForLoginSecret(never, HOST, Date.now(), { ...opts, stop })).toBeNull()
  })

  it('stops when the login is over', async () => {
    const search = vi.fn(async () => [])
    const mail: MailLookup = { search, messages: async () => [] }
    let over = false
    const sleep = async () => void (over = true)
    const opts = { intervalMs: 1_000, sleep, stop: () => over }
    expect(await waitForLoginSecret(mail, HOST, Date.now(), opts)).toBeNull()
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('lets a Gmail failure through, so the caller can ask for the link instead', async () => {
    const mail: MailLookup = {
      search: async () => Promise.reject(new Error('no Google account')),
      messages: async () => [],
    }
    await expect(
      waitForLoginSecret(mail, HOST, Date.now(), { intervalMs: 1, stop: () => false }),
    ).rejects.toThrow('no Google account')
  })
})
