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
  fetchMailCounts,
  htmlToText,
  listThreads,
  messageUrl,
  readThread,
  markThreadRead,
  setThreadStarred,
  archiveThread,
  trashThread,
  fetchCategoryUnread,
  fetchCategoryCounts,
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

/** The `q` Gmail was actually asked, decoded. Reading the parameter rather than
 *  the URL matters: a space is encoded as `+`, which `decodeURIComponent` leaves
 *  alone, so a naive assertion passes or fails for the wrong reason. */
function queryParam(url: string): string {
  return new URL(url).searchParams.get('q') ?? ''
}

/** A fake Gmail that answers threads.list, threads.get and labels.list. */
function gmail(
  list: { id: string }[],
  threads: Record<string, unknown>,
  labels: RawLabel[] = [],
  nextPageToken?: string,
) {
  const seen: string[] = []
  const fetchImpl = vi.fn(async (url: string) => {
    seen.push(url)
    const path = new URL(url).pathname
    const body = path.endsWith('/labels')
      ? { labels }
      : path.endsWith('/threads')
        ? { threads: list, nextPageToken }
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
            header('From', '"Ada Holm" <ada@syv.ai>'),
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

    const [summary] = (await listThreads(api)).threads

    // "Re: Q2 budget" would make a renamed thread look like a different one.
    expect(summary!.subject).toBe('Q2 budget')
    // A bare address with no display name: the name falls back to it so a row
    // always has something to print, and the address travels either way.
    expect(summary!.from).toEqual({ name: 'someone@else.com', email: 'someone@else.com' })
    expect(summary!.date).toBe(new Date(1_000_000_060_000).toISOString())
    expect(summary!.messageCount).toBe(2)
  })

  it('marks a thread unread when any message in it is', async () => {
    const { api } = gmail([{ id: 't1' }], { t1: thread })
    expect((await listThreads(api)).threads[0]!.unread).toBe(true)
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

    expect((await listThreads(api)).threads[0]!.answered).toBe(true)
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
    expect((await listThreads(api)).threads[0]!.answered).toBe(false)
  })

  it('builds the permalink from the first message’s Message-ID', async () => {
    const { api } = gmail([{ id: 't1' }], { t1: thread })
    expect(decodeURIComponent((await listThreads(api)).threads[0]!.webUrl)).toContain(
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
    expect((await listThreads(api)).threads[0]!.starred).toBe(true)
  })

  it('marks an important thread', async () => {
    const important = {
      id: 't1',
      messages: [
        { id: 'm1', internalDate: '1000', labelIds: ['INBOX', 'IMPORTANT'], payload: { headers: [] } },
      ],
    }
    const { api } = gmail([{ id: 't1' }], { t1: important })

    expect((await listThreads(api)).threads[0]!.important).toBe(true)
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
    const [summary] = (await listThreads(api)).threads
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

      expect((await listThreads(api)).threads[0]!.category).toBe(category)
    }
  })

  it('leaves category null when Gmail assigns none', async () => {
    const { api } = gmail([{ id: 't1' }], {
      t1: {
        id: 't1',
        messages: [{ id: 'm1', internalDate: '1000', labelIds: ['INBOX'], payload: { headers: [] } }],
      },
    })

    expect((await listThreads(api)).threads[0]!.category).toBeNull()
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
    expect((await listThreads(api)).threads[0]!.labels).toEqual(['Work/Clients'])
  })

  it('names the labels a thread is filed under, rather than showing their ids', async () => {
    const { api } = gmail([{ id: 't1' }], { t1: filed }, USER_LABELS)

    // `Label_12` is not a thing to show anyone.
    expect((await listThreads(api)).threads[0]!.labels).toEqual(['Work/Clients'])
  })

  it('drops a label it cannot name rather than showing the raw id', async () => {
    const { api } = gmail([{ id: 't1' }], { t1: filed }, [])

    expect((await listThreads(api)).threads[0]!.labels).toEqual([])
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
    expect((await listThreads(both.api)).threads[0]!.unsubscribeUrl).toBe('https://list.test/unsub?u=9')

    const mailtoOnly = gmail([{ id: 't1' }], { t1: newsletter('<mailto:stop@list.test>') })
    expect((await listThreads(mailtoOnly.api)).threads[0]!.unsubscribeUrl).toBeNull()
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

  /**
   * The category filter is a **query**, not a client-side filter.
   *
   * Gmail's search grammar already has `category:primary`, the search box
   * passes that grammar through verbatim, and composing the two keeps one code
   * path instead of two ways to narrow a list that then disagree.
   */

  it('composes the category into Gmail’s own query grammar', async () => {
    const { api, seen } = gmail([{ id: 't1' }], { t1: thread })

    await listThreads(api, { category: 'primary' })

    expect(new URL(seen[0]!).searchParams.get('q')).toContain('category:primary')
  })

  it('keeps the user’s query when a category is also set', async () => {
    const { api, seen } = gmail([{ id: 't1' }], { t1: thread })

    await listThreads(api, { query: 'from:jane', category: 'promotions' })

    // Searching inside Promotions has to work; dropping either half makes the
    // search box lie about what it is searching.
    const q = new URL(seen[0]!).searchParams.get('q')!
    expect(q).toContain('from:jane')
    expect(q).toContain('category:promotions')
  })

  it('returns the page token so the list can load more', async () => {
    const { api } = gmail([{ id: 't1' }], { t1: thread }, [], 'page-2')

    expect((await listThreads(api)).nextPageToken).toBe('page-2')
  })

  it('reports null when there is no further page', async () => {
    const { api } = gmail([{ id: 't1' }], { t1: thread })

    expect((await listThreads(api)).nextPageToken).toBeNull()
  })

  it('passes the page token back to Gmail', async () => {
    const { api, seen } = gmail([{ id: 't1' }], { t1: thread })

    await listThreads(api, { pageToken: 'page-2' })

    expect(new URL(seen[0]!).searchParams.get('pageToken')).toBe('page-2')
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
                header('From', '"Holm, Ada" <ada@syv.ai>'),
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
      from: { name: 'Holm, Ada', email: 'ada@syv.ai' },
      body: 'here is the plan',
    })
    // A comma inside a quoted display name must not split one person into two.
    // Both halves travel now: the name is what a list shows, the address is the
    // only thing that identifies them — see `parseAddress`.
    expect(thread.messages[0]!.to).toEqual([
      { name: 'Doe, Jane', email: 'jane@x.com' },
      { name: 'bob@y.com', email: 'bob@y.com' },
    ])
  })

  /**
   * Attachments — free, because `readThread` already asks for `format=full`,
   * so the parts are in the response either way.
   */

  it('lists a message’s attachments', async () => {
    const { api } = gmail([], {
      t1: {
        id: 't1',
        messages: [
          {
            id: 'm1',
            internalDate: '1000',
            payload: {
              headers: [header('Subject', 'The deck')],
              mimeType: 'multipart/mixed',
              parts: [
                { mimeType: 'text/plain', body: { data: b64('see attached') } },
                {
                  mimeType: 'application/pdf',
                  filename: 'q2-deck.pdf',
                  body: { size: 482_113, attachmentId: 'att-1' },
                },
              ],
            },
          },
        ],
      },
    })

    const [message] = (await readThread(api, 't1')).messages

    expect(message!.attachments).toEqual([
      { filename: 'q2-deck.pdf', mimeType: 'application/pdf', size: 482_113 },
    ])
  })

  it('does not mistake the body for an attachment', async () => {
    const { api } = gmail([], {
      t1: {
        id: 't1',
        messages: [
          {
            id: 'm1',
            payload: {
              headers: [],
              mimeType: 'multipart/alternative',
              parts: [
                { mimeType: 'text/plain', body: { data: b64('the message') } },
                { mimeType: 'text/html', body: { data: b64('<p>the message</p>') } },
              ],
            },
          },
        ],
      },
    })

    // The mirror of `bodyTextOf`'s attachment test: a part with no filename is
    // the message, however file-like its mime type looks.
    expect((await readThread(api, 't1')).messages[0]!.attachments).toEqual([])
  })

  it('finds an attachment nested in a multipart tree', async () => {
    const { api } = gmail([], {
      t1: {
        id: 't1',
        messages: [
          {
            id: 'm1',
            payload: {
              headers: [],
              mimeType: 'multipart/mixed',
              parts: [
                {
                  mimeType: 'multipart/related',
                  parts: [
                    { mimeType: 'text/html', body: { data: b64('<p>hi</p>') } },
                    {
                      mimeType: 'image/png',
                      filename: 'signature.png',
                      body: { size: 4_096, attachmentId: 'att-2' },
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    })

    expect((await readThread(api, 't1')).messages[0]!.attachments).toEqual([
      { filename: 'signature.png', mimeType: 'image/png', size: 4_096 },
    ])
  })

  it('reads Cc alongside To', async () => {
    const { api } = gmail([], {
      t1: {
        id: 't1',
        messages: [
          {
            id: 'm1',
            payload: {
              headers: [
                header('To', 'jane@x.com'),
                header('Cc', '"Doe, Bob" <bob@y.com>, sam@z.com'),
              ],
              mimeType: 'text/plain',
              body: { data: b64('hi') },
            },
          },
        ],
      },
    })

    // Who else saw this is part of reading it — a reply-all is a different act
    // from a reply, and the header is the only thing that says which.
    expect((await readThread(api, 't1')).messages[0]!.cc).toEqual([
      { name: 'Doe, Bob', email: 'bob@y.com' },
      { name: 'sam@z.com', email: 'sam@z.com' },
    ])
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
          to: ['ada@syv.ai'],
          date: '2026-08-04T09:00:00.000Z',
          body: 'the plain one',
          html: '<p>the html one</p>',
        },
      ],
    })

    expect(projected.messages[0]).toEqual({
      id: 'm1',
      from: 'Jane',
      to: ['ada@syv.ai'],
      date: '2026-08-04T09:00:00.000Z',
      body: 'the plain one',
    })
    // Not merely falsy — the key must be absent, or it lands in the JSON the
    // agent reads and doubles the size of every `holi-google read`.
    expect('html' in projected.messages[0]!).toBe(false)
  })
})

/**
 * The unread filter, the counts, and how fresh a page is.
 *
 * All three exist for the list footer and its toggle. The counts are the one
 * that needed care: the category picker deliberately refuses to show
 * `resultSizeEstimate`, and this must not quietly reintroduce the same problem
 * under a different name.
 */
describe('unread, counts and freshness', () => {
  it('composes is:unread into the one query grammar', async () => {
    const { api, seen } = gmail([], {})

    await listThreads(api, { unread: true })

    // Gmail's own grammar, ANDed like the category is — so there is one way to
    // narrow a list rather than a query and a client-side filter that can
    // disagree about what is on screen. Read as a parameter, not by decoding
    // the URL: a space is `+` in a query string and survives decodeURIComponent.
    expect(queryParam(seen[0]!)).toBe('in:inbox is:unread')
  })

  it('composes the category and unread together', async () => {
    const { api, seen } = gmail([], {})

    await listThreads(api, { query: 'from:jane', category: 'promotions', unread: true })

    const asked = queryParam(seen[0]!)
    expect(asked).toContain('from:jane')
    expect(asked).toContain('category:promotions')
    expect(asked).toContain('is:unread')
  })

  it('leaves the query alone when unread is off', async () => {
    const { api, seen } = gmail([], {})

    await listThreads(api, { unread: false })

    expect(queryParam(seen[0]!)).not.toContain('is:unread')
  })

  it('stamps a page with when it was actually obtained', async () => {
    const { api } = gmail([], {})
    const before = Date.now()

    const page = await listThreads(api)

    // The footer says how old what you are reading is, so the time has to come
    // from the fetch rather than from the render.
    expect(Date.parse(page.syncedAt)).toBeGreaterThanOrEqual(before)
  })

  it('reads exact inbox counts from the label, not an estimate', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ threadsTotal: 431, threadsUnread: 7 }),
      text: async () => '',
    })) as unknown as typeof globalThis.fetch
    const api = new GoogleApi({ accessToken: async () => 'at', fetch: fetchImpl })

    // Gmail's own bookkeeping for the label. `resultSizeEstimate` is the thing
    // the category picker refuses to show, because an approximate number
    // presented as a count is one people trust and it is wrong.
    expect(await fetchMailCounts(api)).toEqual({ unread: 7, total: 431 })
  })

  it('gives no number rather than a wrong one when the count fails', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'boom',
    })) as unknown as typeof globalThis.fetch
    const api = new GoogleApi({ accessToken: async () => 'at', fetch: fetchImpl })

    // A footer decoration must never cost the mail it sits under, and "0
    // unread" would be a claim rather than an absence.
    expect(await fetchMailCounts(api)).toBeNull()
  })
})

describe('addresses', () => {
  it('keeps the address as well as the name, and lowercases it', async () => {
    const { api } = gmail([{ id: 't1' }], {
      t1: {
        id: 't1',
        messages: [
          {
            id: 'm1',
            internalDate: '1000',
            payload: {
              mimeType: 'text/plain',
              headers: [
                header('Subject', 'Hi'),
                header('From', '"Mette Nielsen" <Mette@SYV.ai>'),
              ],
              body: { data: b64('hi') },
            },
          },
        ],
      },
    })

    const { from } = (await readThread(api, 't1')).messages[0]!

    // Addresses are compared, not only shown — two spellings of one colleague
    // must group, and case is not significant in any mail system in use.
    expect(from).toEqual({ name: 'Mette Nielsen', email: 'mette@syv.ai' })
  })

  it('offers no address when the header carries nothing that looks like one', async () => {
    const { api } = gmail([{ id: 't1' }], {
      t1: {
        id: 't1',
        messages: [
          {
            id: 'm1',
            internalDate: '1000',
            payload: {
              mimeType: 'text/plain',
              headers: [header('Subject', 'Hi'), header('From', 'Mail Delivery Subsystem')],
              body: { data: b64('hi') },
            },
          },
        ],
      },
    })

    const { from } = (await readThread(api, 't1')).messages[0]!

    // An empty `email` is the signal the UI reads as "show the name, offer no
    // mailto:" — a link to nothing is worse than plain text.
    expect(from).toEqual({ name: 'Mail Delivery Subsystem', email: '' })
  })
})

/**
 * The number beside a Gmail tab.
 *
 * The picker showed none for a long time, and the reason was sound: the obvious
 * source is `resultSizeEstimate`, and an estimate presented as a count is a
 * number people trust and it is wrong. What these pin is the source that made
 * counts possible without breaking that rule — and, in particular, that it is
 * scoped to the **inbox**, because the other exact source (`labels.get` on
 * `CATEGORY_PROMOTIONS`) counts the whole mailbox including archived mail.
 */
describe('category counts', () => {
  function counting(body: unknown) {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url)
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
    })
    const api = new GoogleApi({
      accessToken: async () => 'at-1',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    })
    return { api, seen }
  }

  it('counts the ids Gmail returns rather than trusting an estimate', async () => {
    const { api } = counting({
      threads: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      // Present and deliberately wrong: if this is ever read, the count stops
      // being exact and the picker goes back to lying.
      resultSizeEstimate: 41,
    })

    expect(await fetchCategoryUnread(api, 'promotions')).toEqual({ count: 3, more: false })
  })

  it('asks for unread threads in the INBOX, not for the whole category', async () => {
    const { api, seen } = counting({ threads: [] })

    await fetchCategoryUnread(api, 'promotions')

    // Every term matters. Without `in:inbox` this counts archived promotional
    // mail, which is a number about the mailbox rather than about the tab.
    const q = new URL(seen[0]!).searchParams.get('q')
    expect(q).toContain('in:inbox')
    expect(q).toContain('category:promotions')
    expect(q).toContain('is:unread')
  })

  it('says `more` when the answer ran past a page', async () => {
    // 500 is Gmail's maximum. Reporting it as a flat "500" would be a number
    // that quietly means "at least 500".
    const { api } = counting({ threads: [{ id: 'a' }], nextPageToken: 'p2' })

    expect(await fetchCategoryUnread(api, 'updates')).toEqual({ count: 1, more: true })
  })

  it('answers null for one tab rather than failing the picker', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => '{}',
    }))
    const api = new GoogleApi({
      accessToken: async () => 'at-1',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    })

    expect(await fetchCategoryUnread(api, 'social')).toBeNull()
  })

  it('covers every tab the picker offers', async () => {
    const { api, seen } = counting({ threads: [{ id: 'a' }] })

    const counts = await fetchCategoryCounts(api)

    // A tab with no entry renders no number at all, so a category missing here
    // is a silently blank row rather than an error.
    expect(Object.keys(counts).sort()).toEqual([
      'forums',
      'primary',
      'promotions',
      'social',
      'updates',
    ])
    expect(seen).toHaveLength(5)
  })
})

/**
 * The four writes (D68).
 *
 * What these protect is **which request each one makes**, because every wrong
 * answer here is silent. Trash in particular: adding a `TRASH` label through
 * `modify` returns 200 and does not trash anything, so a test that only
 * asserted "a POST happened" would pass against a feature that never worked.
 */
describe('thread mutations', () => {
  /** A Gmail that records writes and answers each with an empty body. */
  function writable() {
    const posts: { url: string; body: unknown }[] = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) })
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
    })
    const api = new GoogleApi({
      accessToken: async () => 'at-1',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    })
    return { posts, api }
  }

  const MODIFY = 'https://gmail.googleapis.com/gmail/v1/users/me/threads/t1/modify'

  it('marks a thread read by removing UNREAD from it', async () => {
    const { posts, api } = writable()

    await markThreadRead(api, 't1')

    expect(posts).toEqual([{ url: MODIFY, body: { removeLabelIds: ['UNREAD'] } }])
  })

  it('stars and unstars through the same endpoint, in opposite directions', async () => {
    const { posts, api } = writable()

    await setThreadStarred(api, 't1', true)
    await setThreadStarred(api, 't1', false)

    expect(posts[0]).toEqual({ url: MODIFY, body: { addLabelIds: ['STARRED'] } })
    expect(posts[1]).toEqual({ url: MODIFY, body: { removeLabelIds: ['STARRED'] } })
  })

  it('archives by removing INBOX — the thread stays, it just leaves the inbox', async () => {
    const { posts, api } = writable()

    await archiveThread(api, 't1')

    expect(posts).toEqual([{ url: MODIFY, body: { removeLabelIds: ['INBOX'] } }])
  })

  it('trashes through /trash, NOT by adding a TRASH label', async () => {
    // The failure this exists for: `modify` with `addLabelIds: ['TRASH']`
    // answers 200 and leaves the thread exactly where it was. There is no error
    // to notice — only mail that comes back after a refresh.
    const { posts, api } = writable()

    await trashThread(api, 't1')

    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/threads/t1/trash')
    expect(JSON.stringify(posts[0]!.body)).not.toContain('TRASH')
  })

  it('lets a refusal through rather than reporting a write that did not happen', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } }),
      json: async () => ({}),
    }))
    const api = new GoogleApi({
      accessToken: async () => 'at-1',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    })

    // Swallowing this is what would let the cache record an archive Google
    // refused — the one divergence a delta sync cannot detect, because from
    // Gmail's side nothing ever changed.
    await expect(archiveThread(api, 't1')).rejects.toThrow()
  })
})
