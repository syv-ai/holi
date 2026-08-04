/**
 * Gmail parsing — the MIME walk, the header quirks, and the stable link.
 *
 * Almost every test here is a case that produces *plausible but wrong* output
 * rather than an error: a subject taken from the wrong message, a body decoded
 * with the wrong base64 alphabet, a display name split in half by its own
 * comma, or a permalink that opens the wrong mailbox.
 */
import { describe, expect, it, vi } from 'vitest'
import { GoogleApi } from '../src/main/google/api'
import { bodyTextOf, htmlToText, listThreads, messageUrl, readThread } from '../src/main/google/gmail'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

function header(name: string, value: string) {
  return { name, value }
}

/** A fake Gmail that answers threads.list and threads.get. */
function gmail(list: { id: string }[], threads: Record<string, unknown>) {
  const seen: string[] = []
  const fetchImpl = vi.fn(async (url: string) => {
    seen.push(url)
    const path = new URL(url).pathname
    const body = path.endsWith('/threads')
      ? { threads: list }
      : threads[path.split('/').pop()!] ?? {}
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }) as unknown as typeof globalThis.fetch

  return { api: new GoogleApi({ accessToken: async () => 'at', fetch: fetchImpl }), seen }
}

describe('messageUrl', () => {
  it('searches by rfc822msgid, so the link survives a multi-account login', () => {
    const url = messageUrl('<abc@syv.ai>', 'thread-1')

    // The /u/0/ slot is login-order-dependent; the search resolves against
    // whichever account actually holds the message.
    expect(url).toContain('#search/')
    expect(decodeURIComponent(url)).toContain('rfc822msgid:abc@syv.ai')
    // Angle brackets are part of the header, not of the id.
    expect(decodeURIComponent(url)).not.toContain('<')
  })

  it('falls back to the thread id when a message has no Message-ID', () => {
    expect(messageUrl(null, 'thread-1')).toContain('#all/thread-1')
  })
})

describe('bodyTextOf', () => {
  it('prefers text/plain', () => {
    const body = bodyTextOf({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('the plain one') } },
        { mimeType: 'text/html', body: { data: b64('<p>the html one</p>') } },
      ],
    })

    expect(body).toBe('the plain one')
  })

  it('decodes base64url — a body containing - or _ must not corrupt', () => {
    // A payload whose base64 encoding contains the url-safe characters.
    const text = 'subject ?? >>> ~~~ ???'
    const body = bodyTextOf({ mimeType: 'text/plain', body: { data: b64(text) } })

    expect(body).toBe(text)
  })

  it('falls back to html, converted to text', () => {
    const body = bodyTextOf({
      mimeType: 'multipart/alternative',
      parts: [{ mimeType: 'text/html', body: { data: b64('<p>hello</p><p>world</p>') } }],
    })

    expect(body).toBe('hello\n\nworld')
  })

  it('finds the body in a nested multipart tree', () => {
    const body = bodyTextOf({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [{ mimeType: 'text/plain', body: { data: b64('nested') } }],
        },
      ],
    })

    expect(body).toBe('nested')
  })

  it('never mistakes an attachment for the message body', () => {
    const body = bodyTextOf({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64('ATTACHED FILE') } },
        { mimeType: 'text/plain', body: { data: b64('the actual message') } },
      ],
    })

    expect(body).toBe('the actual message')
  })

  it('reads a single-part message whose body sits on the payload', () => {
    expect(bodyTextOf({ mimeType: 'text/plain', body: { data: b64('just this') } })).toBe('just this')
  })
})

describe('htmlToText', () => {
  it('drops script and style content entirely rather than flattening it', () => {
    const text = htmlToText('<style>.a{color:red}</style><script>alert(1)</script><p>hi</p>')

    expect(text).toBe('hi')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('color:red')
  })

  it('turns breaks and blocks into newlines, and collapses the runs', () => {
    expect(htmlToText('<p>a</p><br><br><br><p>b</p>')).toBe('a\n\nb')
  })

  it('decodes the entities that otherwise read as noise', () => {
    expect(htmlToText('<p>Tom &amp; Jerry &lt;3 &quot;x&quot;&nbsp;y</p>')).toBe('Tom & Jerry <3 "x" y')
  })

  it('strips tags without executing anything — it is a formatter, not a sanitizer', () => {
    // The safety property is that the OUTPUT is rendered as text; this only has
    // to be readable.
    expect(htmlToText('<img src=x onerror=alert(1)><b>bold</b>')).toBe('bold')
  })
})

describe('listThreads', () => {
  const thread = {
    id: 't1',
    messages: [
      {
        id: 'm1',
        internalDate: '1000000000000',
        labelIds: ['INBOX'],
        payload: {
          headers: [
            header('Subject', 'Q2 budget'),
            header('From', '"Nicolai Thomsen" <nicolai@syv.ai>'),
            header('Message-ID', '<first@syv.ai>'),
          ],
        },
      },
      {
        id: 'm2',
        internalDate: '1000000060000',
        labelIds: ['INBOX', 'UNREAD'],
        snippet: 'sounds good',
        payload: {
          headers: [header('Subject', 'Re: Q2 budget'), header('From', 'someone@else.com')],
        },
      },
    ],
  }

  it('defaults to the inbox and passes a query through verbatim', async () => {
    const { api, seen } = gmail([{ id: 't1' }], { t1: thread })

    await listThreads(api)
    expect(new URL(seen[0]!).searchParams.get('q')).toBe('in:inbox')

    const second = gmail([{ id: 't1' }], { t1: thread })
    await listThreads(second.api, { query: 'from:x is:unread' })
    expect(new URL(second.seen[0]!).searchParams.get('q')).toBe('from:x is:unread')
  })

  it('takes the subject from the first message and the sender from the last', async () => {
    const { api } = gmail([{ id: 't1' }], { t1: thread })

    const [summary] = await listThreads(api)

    // "Re: Q2 budget" would make a renamed thread look like a different one.
    expect(summary!.subject).toBe('Q2 budget')
    expect(summary!.from).toBe('someone@else.com')
    expect(summary!.date).toBe(new Date(1_000_000_060_000).toISOString())
    expect(summary!.messageCount).toBe(2)
  })

  it('marks a thread unread when any message in it is', async () => {
    const { api } = gmail([{ id: 't1' }], { t1: thread })
    expect((await listThreads(api))[0]!.unread).toBe(true)
  })

  it('builds the permalink from the first message’s Message-ID', async () => {
    const { api } = gmail([{ id: 't1' }], { t1: thread })
    expect(decodeURIComponent((await listThreads(api))[0]!.webUrl)).toContain(
      'rfc822msgid:first@syv.ai',
    )
  })

  it('requests metadata, not full — a list must not download every body', async () => {
    const { api, seen } = gmail([{ id: 't1' }], { t1: thread })

    await listThreads(api)

    const get = seen.find((u) => u.includes('/threads/t1'))!
    expect(new URL(get).searchParams.get('format')).toBe('metadata')
  })
})

describe('readThread', () => {
  it('returns each message with its text body, sender and recipients', async () => {
    const { api } = gmail([], {
      t1: {
        id: 't1',
        messages: [
          {
            id: 'm1',
            internalDate: '1000000000000',
            payload: {
              headers: [
                header('Subject', 'Plan'),
                header('From', '"Thomsen, Nicolai" <nicolai@syv.ai>'),
                header('To', '"Doe, Jane" <jane@x.com>, bob@y.com'),
                header('Message-ID', '<plan@syv.ai>'),
              ],
              mimeType: 'text/plain',
              body: { data: b64('here is the plan') },
            },
          },
        ],
      },
    })

    const thread = await readThread(api, 't1')

    expect(thread.subject).toBe('Plan')
    expect(thread.messages[0]).toMatchObject({
      from: 'Thomsen, Nicolai',
      body: 'here is the plan',
    })
    // A comma inside a quoted display name must not split one person into two.
    expect(thread.messages[0]!.to).toEqual(['Doe, Jane', 'bob@y.com'])
  })

  it('shows an untitled thread rather than an empty heading', async () => {
    const { api } = gmail([], { t1: { id: 't1', messages: [{ id: 'm1', payload: { headers: [] } }] } })

    expect((await readThread(api, 't1')).subject).toBe('(no subject)')
  })
})
