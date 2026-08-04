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
import {
  bodyHtmlOf,
  bodyTextOf,
  htmlToText,
  listThreads,
  messageUrl,
  readThread,
  textOnly,
} from '../src/main/google/gmail'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

function header(name: string, value: string) {
  return { name, value }
}

interface RawLabel {
  id: string
  name: string
  type: string
}

/** A fake Gmail that answers threads.list, threads.get and labels.list. */
function gmail(list: { id: string }[], threads: Record<string, unknown>, labels: RawLabel[] = []) {
  const seen: string[] = []
  const fetchImpl = vi.fn(async (url: string) => {
    seen.push(url)
    const path = new URL(url).pathname
    const body = path.endsWith('/labels')
      ? { labels }
      : path.endsWith('/threads')
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

describe('bodyHtmlOf', () => {
  it('returns the html part verbatim — sanitizing is the renderer’s job', () => {
    const html = bodyHtmlOf({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('the plain one') } },
        { mimeType: 'text/html', body: { data: b64('<p style="color:red">the html one</p>') } },
      ],
    })

    // Untouched, including the styling: main is not in the business of deciding
    // what markup is safe, and half-stripping here would only make the renderer's
    // sanitizer harder to reason about.
    expect(html).toBe('<p style="color:red">the html one</p>')
  })

  it('is null when the message has no html part at all', () => {
    expect(bodyHtmlOf({ mimeType: 'text/plain', body: { data: b64('just text') } })).toBeNull()
  })

  it('reads a single-part html message whose body sits on the payload', () => {
    const html = bodyHtmlOf({ mimeType: 'text/html', body: { data: b64('<p>hi</p>') } })

    expect(html).toBe('<p>hi</p>')
  })

  it('never mistakes an html attachment for the message body', () => {
    const html = bodyHtmlOf({
      mimeType: 'multipart/mixed',
      parts: [{ mimeType: 'text/html', filename: 'report.html', body: { data: b64('<p>ATTACHED</p>') } }],
    })

    expect(html).toBeNull()
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
    // Its consumers are the agent CLI and the text fallback, and both put the
    // result in a text node or a JSON string. Nothing renders this as markup —
    // the UI reads `html` and sanitizes it (renderer/src/lib/mail-html.ts).
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

  /**
   * "Answered" means **the ball is in their court**: the last message in the
   * thread is one the user sent. Deliberately not "there is a sent message
   * somewhere in here" — in a long back-and-forth that is true forever and
   * therefore says nothing about what is still outstanding.
   */
  it('marks a thread answered when the last message is one the user sent', async () => {
    const answered = {
      id: 't1',
      messages: [
        { id: 'm1', internalDate: '1000', labelIds: ['INBOX'], payload: { headers: [] } },
        { id: 'm2', internalDate: '2000', labelIds: ['SENT'], payload: { headers: [] } },
      ],
    }
    const { api } = gmail([{ id: 't1' }], { t1: answered })

    expect((await listThreads(api))[0]!.answered).toBe(true)
  })

  it('is not answered when they wrote back after the user’s reply', async () => {
    const theirTurn = {
      id: 't1',
      messages: [
        { id: 'm1', internalDate: '1000', labelIds: ['SENT'], payload: { headers: [] } },
        { id: 'm2', internalDate: '2000', labelIds: ['INBOX'], payload: { headers: [] } },
      ],
    }
    const { api } = gmail([{ id: 't1' }], { t1: theirTurn })

    // The user replied, and then someone answered — it needs them again, so the
    // marker has to come back off.
    expect((await listThreads(api))[0]!.answered).toBe(false)
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

  /**
   * The flags a mail list is actually scanned by.
   *
   * Gmail sends all of these on the same `metadata` request the list already
   * makes — every one of them was being parsed away and thrown out.
   */

  it('marks a starred thread', async () => {
    const starred = {
      id: 't1',
      messages: [
        { id: 'm1', internalDate: '1000', labelIds: ['INBOX'], payload: { headers: [] } },
        { id: 'm2', internalDate: '2000', labelIds: ['INBOX', 'STARRED'], payload: { headers: [] } },
      ],
    }
    const { api } = gmail([{ id: 't1' }], { t1: starred })

    // Starred on *any* message: that is what Gmail's own star on a thread row
    // means, and the thread is the unit the user acts on.
    expect((await listThreads(api))[0]!.starred).toBe(true)
  })

  it('marks an important thread', async () => {
    const important = {
      id: 't1',
      messages: [
        { id: 'm1', internalDate: '1000', labelIds: ['INBOX', 'IMPORTANT'], payload: { headers: [] } },
      ],
    }
    const { api } = gmail([{ id: 't1' }], { t1: important })

    expect((await listThreads(api))[0]!.important).toBe(true)
  })

  it('marks a thread holding an unsent draft', async () => {
    const drafting = {
      id: 't1',
      messages: [
        { id: 'm1', internalDate: '1000', labelIds: ['INBOX'], payload: { headers: [] } },
        { id: 'm2', internalDate: '2000', labelIds: ['DRAFT'], payload: { headers: [] } },
      ],
    }
    const { api } = gmail([{ id: 't1' }], { t1: drafting })

    // "You started replying and stopped" is a third state, distinct from both
    // `answered` and untouched — and the one most likely to be forgotten.
    const [summary] = await listThreads(api)
    expect(summary!.hasDraft).toBe(true)
    expect(summary!.answered).toBe(false)
  })

  it('reads the category from Gmail’s own label', async () => {
    for (const [label, category] of [
      ['CATEGORY_PROMOTIONS', 'promotions'],
      ['CATEGORY_SOCIAL', 'social'],
      ['CATEGORY_UPDATES', 'updates'],
      ['CATEGORY_FORUMS', 'forums'],
      // The one that gets guessed wrong: Gmail calls the Primary tab
      // "personal", and a `primary` lookup against the label name finds nothing.
      ['CATEGORY_PERSONAL', 'primary'],
    ] as const) {
      const { api } = gmail([{ id: 't1' }], {
        t1: {
          id: 't1',
          messages: [
            { id: 'm1', internalDate: '1000', labelIds: ['INBOX', label], payload: { headers: [] } },
          ],
        },
      })

      expect((await listThreads(api))[0]!.category).toBe(category)
    }
  })

  it('leaves category null when Gmail assigns none', async () => {
    const { api } = gmail([{ id: 't1' }], {
      t1: {
        id: 't1',
        messages: [{ id: 'm1', internalDate: '1000', labelIds: ['INBOX'], payload: { headers: [] } }],
      },
    })

    expect((await listThreads(api))[0]!.category).toBeNull()
  })

  const filed = {
    id: 't1',
    messages: [
      {
        id: 'm1',
        internalDate: '1000',
        labelIds: ['INBOX', 'UNREAD', 'IMPORTANT', 'CATEGORY_UPDATES', 'Label_12'],
        payload: { headers: [] },
      },
    ],
  }
  const USER_LABELS = [{ id: 'Label_12', name: 'Work/Clients', type: 'user' }]

  it('excludes system labels from the label list', async () => {
    const { api } = gmail([{ id: 't1' }], { t1: filed }, USER_LABELS)

    // INBOX and UNREAD are not things the user filed this under; rendering them
    // as chips is noise on every single row.
    expect((await listThreads(api))[0]!.labels).toEqual(['Work/Clients'])
  })

  it('names the labels a thread is filed under, rather than showing their ids', async () => {
    const { api } = gmail([{ id: 't1' }], { t1: filed }, USER_LABELS)

    // `Label_12` is not a thing to show anyone.
    expect((await listThreads(api))[0]!.labels).toEqual(['Work/Clients'])
  })

  it('drops a label it cannot name rather than showing the raw id', async () => {
    const { api } = gmail([{ id: 't1' }], { t1: filed }, [])

    expect((await listThreads(api))[0]!.labels).toEqual([])
  })

  it('asks Gmail for the label names once, not once per thread', async () => {
    // The N+1 this whole area keeps inviting: a per-thread lookup would be 25
    // extra requests to render 25 chips.
    const { api, seen } = gmail(
      [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
      { t1: filed, t2: filed, t3: filed },
      USER_LABELS,
    )

    await listThreads(api)

    expect(seen.filter((u) => new URL(u).pathname.endsWith('/labels'))).toHaveLength(1)
  })

  it('extracts an unsubscribe URL from a List-Unsubscribe header', async () => {
    const newsletter = (unsubscribe: string) => ({
      id: 't1',
      messages: [
        {
          id: 'm1',
          internalDate: '1000',
          labelIds: ['INBOX'],
          payload: { headers: [header('List-Unsubscribe', unsubscribe)] },
        },
      ],
    })

    // Both forms are legal in one header; the https one is a link Holi can hand
    // to the browser, and a mailto would mean composing on the user's behalf.
    const both = gmail([{ id: 't1' }], {
      t1: newsletter('<mailto:stop@list.test>, <https://list.test/unsub?u=9>'),
    })
    expect((await listThreads(both.api))[0]!.unsubscribeUrl).toBe('https://list.test/unsub?u=9')

    const mailtoOnly = gmail([{ id: 't1' }], { t1: newsletter('<mailto:stop@list.test>') })
    expect((await listThreads(mailtoOnly.api))[0]!.unsubscribeUrl).toBeNull()
  })

  it('asks for the recipient and unsubscribe headers in the same request', async () => {
    // Free: the same `metadata` request the list already makes. Guarding it
    // here because the array form is exactly what the `(no subject)` bug broke.
    const { api, seen } = gmail([{ id: 't1' }], { t1: thread })

    await listThreads(api)

    const asked = new URL(seen.find((u) => u.includes('/threads/t1'))!).searchParams.getAll(
      'metadataHeaders',
    )
    expect(asked).toContain('To')
    expect(asked).toContain('Cc')
    expect(asked).toContain('Reply-To')
    expect(asked).toContain('List-Unsubscribe')
  })

  it('asks for each metadata header as its own query parameter', async () => {
    // The bug this pins: sent as ONE comma-joined value, Gmail reads it as a
    // single header *name*, matches nothing, and returns a message with no
    // headers at all — so every thread in the list renders as "(no subject)"
    // from an empty sender. It fails silently, with a 200.
    const { api, seen } = gmail([{ id: 't1' }], { t1: thread })

    await listThreads(api)

    const get = new URL(seen.find((u) => u.includes('/threads/t1'))!)
    expect(get.searchParams.getAll('metadataHeaders')).toEqual([
      'Subject',
      'From',
      'Date',
      'Message-ID',
      'To',
      'Cc',
      'Reply-To',
      'List-Unsubscribe',
    ])
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

  /**
   * A message carries BOTH representations, and which consumer gets which is the
   * whole design (D67, revised): the UI renders `html` through the renderer's
   * sanitizer so designed mail looks like mail, and the agent reads `body`,
   * because an LLM wants prose and not a table layout.
   */
  it('carries the html body and the text body side by side', async () => {
    const { api } = gmail([], {
      t1: {
        id: 't1',
        messages: [
          {
            id: 'm1',
            internalDate: '1000000000000',
            payload: {
              headers: [header('Subject', 'Newsletter')],
              mimeType: 'multipart/alternative',
              parts: [
                { mimeType: 'text/plain', body: { data: b64('the plain one') } },
                { mimeType: 'text/html', body: { data: b64('<p>the <b>html</b> one</p>') } },
              ],
            },
          },
        ],
      },
    })

    const [message] = (await readThread(api, 't1')).messages

    // The text comes from the real text/plain part, NOT from converting the
    // HTML — the sender wrote it, so it beats anything derived.
    expect(message!.body).toBe('the plain one')
    expect(message!.html).toBe('<p>the <b>html</b> one</p>')
  })

  it('leaves html null for a text-only message', async () => {
    const { api } = gmail([], {
      t1: {
        id: 't1',
        messages: [
          {
            id: 'm1',
            payload: { headers: [], mimeType: 'text/plain', body: { data: b64('hi') } },
          },
        ],
      },
    })

    const [message] = (await readThread(api, 't1')).messages
    expect(message!.body).toBe('hi')
    expect(message!.html).toBeNull()
  })
})

describe('textOnly', () => {
  it('drops html entirely, so the agent never receives markup', () => {
    const projected = textOnly({
      id: 't1',
      subject: 'Newsletter',
      webUrl: 'https://mail.google.com/…',
      messages: [
        {
          id: 'm1',
          from: 'Jane',
          to: ['nicolai@syv.ai'],
          date: '2026-08-04T09:00:00.000Z',
          body: 'the plain one',
          html: '<p>the html one</p>',
        },
      ],
    })

    expect(projected.messages[0]).toEqual({
      id: 'm1',
      from: 'Jane',
      to: ['nicolai@syv.ai'],
      date: '2026-08-04T09:00:00.000Z',
      body: 'the plain one',
    })
    // Not merely falsy — the key must be absent, or it lands in the JSON the
    // agent reads and doubles the size of every `holi-google read`.
    expect('html' in projected.messages[0]!).toBe(false)
  })
})
