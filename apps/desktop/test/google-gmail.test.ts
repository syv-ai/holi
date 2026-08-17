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
  setThreadRead,
  setThreadStarred,
  archiveThread,
  trashThread,
  fetchCategoryUnread,
  fetchCategoryCounts,
  textOnly,
  sendMessage,
  createDraft,
  replyToThread,
  sendInThread,
  saveDraft,
  sendDraft,
  deleteDraft,
  listDrafts,
  readDraft,
  listSendAs,
  fetchAttachment,
  fetchMessageAttachments,
} from '../src/main/google/gmail'
import { buildRfc822, toBase64Url } from '../src/main/google/mime'

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

  /**
   * The Sent mailbox is a **query**, exactly as the category tabs are.
   *
   * Gmail has no separate endpoint for it and does not need one: `in:sent` is
   * the same grammar the search box already speaks, so Sent costs one term
   * rather than a second listing path with its own summary shape and its own
   * bugs.
   */
  it('lists Sent by asking for it, not through a second code path', async () => {
    const { api, seen } = gmail([{ id: 't1' }], { t1: thread })

    await listThreads(api, { mailbox: 'sent' })

    expect(new URL(seen[0]!).searchParams.get('q')).toBe('in:sent')
  })

  it('defaults to the inbox when no mailbox is named', async () => {
    const { api, seen } = gmail([{ id: 't1' }], { t1: thread })

    await listThreads(api, { mailbox: 'inbox' })

    expect(new URL(seen[0]!).searchParams.get('q')).toBe('in:inbox')
  })

  it('lets an explicit query escape the mailbox, as it escapes the tabs', async () => {
    const { api, seen } = gmail([{ id: 't1' }], { t1: thread })

    await listThreads(api, { query: 'from:jane', mailbox: 'sent' })

    // A search that silently stayed inside Sent would come back empty for a
    // reason the user cannot see — the same argument as the category tabs.
    expect(new URL(seen[0]!).searchParams.get('q')).toBe('from:jane')
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

    await setThreadRead(api, 't1', true)

    expect(posts).toEqual([{ url: MODIFY, body: { removeLabelIds: ['UNREAD'] } }])
  })

  it('marks a thread unread by adding UNREAD back', async () => {
    // The other direction, which the agent needs for "leave this one for me"
    // (D70). Read is a two-way label, exactly like starred.
    const { posts, api } = writable()

    await setThreadRead(api, 't1', false)

    expect(posts).toEqual([{ url: MODIFY, body: { addLabelIds: ['UNREAD'] } }])
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

/**
 * Sending, drafting and replying (D70).
 *
 * The fake **refuses the way Google refuses**: a `raw` that is not valid
 * base64url comes back 400. That is the whole point of writing it this way —
 * a fake that accepts any string would pass a plain-base64 bug straight through
 * to the first real send, which is exactly the failure mode D69 named.
 */
describe('send, draft and reply', () => {
  /** Decode what the fake was handed back into an RFC-822 document. */
  function rawOf(body: unknown): string {
    const raw = (body as { raw?: string; message?: { raw?: string } }).raw
      ?? (body as { message?: { raw?: string } }).message?.raw
    if (raw === undefined) throw new Error('the request carried no raw message')
    return Buffer.from(raw, 'base64url').toString('utf8')
  }

  function headerIn(raw: string, name: string): string | undefined {
    const line = raw
      .split('\r\n\r\n')[0]!
      .split('\r\n')
      .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    return line?.slice(line.indexOf(':') + 1).trim()
  }

  /** A Gmail that serves one thread and accepts writes — validating `raw` the
   *  way Gmail does, so an encoding bug fails here rather than in a mailbox. */
  function mailbox(thread?: Record<string, unknown>, sendResponse: unknown = { id: 'm-9' }) {
    const posts: { url: string; body: unknown }[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') {
        return { ok: true, status: 200, json: async () => thread ?? {}, text: async () => '{}' }
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      const raw = (body.raw ?? (body.message as { raw?: string } | undefined)?.raw) as
        | string
        | undefined
      if (raw !== undefined && !/^[A-Za-z0-9_-]+$/.test(raw)) {
        // Gmail's own refusal for a `raw` in the wrong alphabet or with padding.
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: { errors: [{ reason: 'invalidArgument' }] } }),
          json: async () => ({}),
        }
      }
      posts.push({ url, body })
      return { ok: true, status: 200, json: async () => sendResponse, text: async () => '{}' }
    })
    const api = new GoogleApi({
      accessToken: async () => 'at-1',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    })
    return { posts, api }
  }

  /** A two-message thread: Ada wrote, the user replied, Ada wrote again. */
  const THREAD = {
    id: 't1',
    messages: [
      {
        id: 'm1',
        labelIds: ['INBOX'],
        internalDate: '1000',
        payload: {
          headers: [
            header('Message-ID', '<msg-1@mail.example>'),
            header('Subject', 'Q2 budget'),
            header('From', 'Ada Holm <ada@syv.ai>'),
            header('To', 'me@syv.ai'),
          ],
        },
      },
      {
        id: 'm2',
        labelIds: ['SENT'],
        internalDate: '2000',
        payload: {
          headers: [
            header('Message-ID', '<msg-2@mail.example>'),
            header('Subject', 'Re: Q2 budget'),
            header('From', 'me@syv.ai'),
            header('To', 'ada@syv.ai'),
          ],
        },
      },
      {
        id: 'm3',
        labelIds: ['INBOX'],
        internalDate: '3000',
        payload: {
          headers: [
            header('Message-ID', '<msg-3@mail.example>'),
            header('Subject', 'Re: Q2 budget'),
            header('From', 'Ada Holm <ada@syv.ai>'),
            header('To', 'me@syv.ai'),
            header('Cc', 'Bo <bo@syv.ai>'),
          ],
        },
      },
    ],
  }

  it('posts a base64url raw message to messages/send', async () => {
    const { posts, api } = mailbox()

    const result = await sendMessage(api, {
      to: ['ada@syv.ai'],
      subject: 'Q2 budget',
      body: 'Here it is.',
    })

    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
    expect(headerIn(rawOf(posts[0]!.body), 'To')).toBe('ada@syv.ai')
    expect(result.id).toBe('m-9')
  })

  it('reports success when the response body cannot be read — a resend is worse', async () => {
    // Google accepted it. The mail is gone. Anything but success here makes the
    // caller try again, and a real person gets two copies.
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
      text: async () => '<html>',
    }))
    const flaky = new GoogleApi({
      accessToken: async () => 'at-1',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    })

    await expect(
      sendMessage(flaky, { to: ['ada@syv.ai'], subject: 'x', body: 'y' }),
    ).resolves.toEqual({ id: null })
  })

  it('drafts through the drafts endpoint, filed into its thread', async () => {
    const { posts, api } = mailbox(undefined, { id: 'd-1' })

    const result = await createDraft(
      api,
      { to: ['ada@syv.ai'], subject: 'Q2 budget', body: 'Draft.' },
      't1',
    )

    expect(posts[0]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts')
    // Without threadId the draft is a loose message that never joins the thread.
    expect((posts[0]!.body as { message: { threadId?: string } }).message.threadId).toBe('t1')
    expect(result.id).toBe('d-1')
  })

  it('carries In-Reply-To AND References so the reply stays in its thread', async () => {
    // The failure this exists for: with In-Reply-To alone the send succeeds,
    // returns an id, and Gmail files it as a brand new thread.
    const { posts, api } = mailbox(THREAD)

    await replyToThread(api, 't1', 'Looks right to me.')

    const raw = rawOf(posts[0]!.body)
    expect(headerIn(raw, 'In-Reply-To')).toBe('<msg-3@mail.example>')
    expect(headerIn(raw, 'References')).toBe(
      '<msg-1@mail.example> <msg-2@mail.example> <msg-3@mail.example>',
    )
  })

  it('addresses the reply to the last sender who is not the user', async () => {
    const { posts, api } = mailbox(THREAD)

    await replyToThread(api, 't1', 'Looks right to me.')

    const raw = rawOf(posts[0]!.body)
    // m3 is the last inbound message; m2 is the user's own and must not be the
    // recipient — replying to yourself is the classic version of this bug.
    expect(headerIn(raw, 'To')).toBe('ada@syv.ai')
  })

  // Reply, not reply-all. Copying the thread's Cc by default means one
  // instruction reaches six people instead of one, on the single operation
  // that reaches people at all — and the user approving the prompt cannot see
  // the recipient list, because it is derived rather than typed.
  it('does not copy the thread’s Cc unless reply-all was asked for', async () => {
    const { posts, api } = mailbox(THREAD)

    await replyToThread(api, 't1', 'Looks right to me.')

    expect(headerIn(rawOf(posts[0]!.body), 'Cc')).toBeUndefined()
  })

  it('copies the Cc when reply-all is asked for explicitly', async () => {
    const { posts, api } = mailbox(THREAD)

    await replyToThread(api, 't1', 'Looks right to me.', { all: true })

    expect(headerIn(rawOf(posts[0]!.body), 'Cc')).toBe('bo@syv.ai')
  })

  it('does not double the Re: prefix on an already-Re: subject', async () => {
    const { posts, api } = mailbox(THREAD)

    await replyToThread(api, 't1', 'Looks right to me.')

    expect(headerIn(rawOf(posts[0]!.body), 'Subject')).toBe('Re: Q2 budget')
  })

  it('adds Re: when the thread subject has none', async () => {
    const plain = {
      id: 't2',
      messages: [
        {
          id: 'm1',
          labelIds: ['INBOX'],
          internalDate: '1000',
          payload: {
            headers: [
              header('Message-ID', '<only@mail.example>'),
              header('Subject', 'Lunch'),
              header('From', 'ada@syv.ai'),
            ],
          },
        },
      ],
    }
    const { posts, api } = mailbox(plain)

    await replyToThread(api, 't2', 'Yes.')

    expect(headerIn(rawOf(posts[0]!.body), 'Subject')).toBe('Re: Lunch')
  })

  it('files the reply into the thread by id, not only by headers', async () => {
    const { posts, api } = mailbox(THREAD)

    await replyToThread(api, 't1', 'Looks right to me.')

    expect((posts[0]!.body as { threadId?: string }).threadId).toBe('t1')
  })

  it('refuses to reply to a thread with nothing to reply to', async () => {
    const { api } = mailbox({ id: 't3', messages: [] })

    await expect(replyToThread(api, 't3', 'Hello?')).rejects.toThrow(/no message/i)
  })
})

/**
 * The composer's Gmail surface (D71).
 *
 * Everything here reaches another human or edits something that will. The fake
 * below **refuses the way Google refuses** — a malformed `raw` is a 400, an
 * unknown draft is a 404, a missing scope is a 403 — because this pillar's
 * standing failure mode is a fake that accepts everything and passes a real bug
 * straight through to a mailbox.
 */
describe('the composer surface', () => {
  interface DraftRecord {
    id: string
    threadId?: string
    raw: string
  }

  /** Decode a `raw` the way Gmail would, so an encoding bug fails here. */
  function decode(raw: string): string {
    return Buffer.from(raw, 'base64url').toString('utf8')
  }

  function headerIn(raw: string, name: string): string | undefined {
    const line = raw
      .split('\r\n\r\n')[0]!
      .split('\r\n')
      .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    return line?.slice(line.indexOf(':') + 1).trim()
  }

  function refuse(status: number, reason: string) {
    return {
      ok: false,
      status,
      text: async () => JSON.stringify({ error: { errors: [{ reason }] } }),
      json: async () => ({}),
    }
  }

  function ok(body: unknown) {
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }

  /**
   * A Gmail that keeps draft state and enforces the refusals that matter.
   *
   * `sendAsScope: false` models an account whose token lacks the settings
   * scope; `drafts` is seeded state so `update`, `read` and `delete` have
   * something real to act on.
   */
  function composer(
    options: {
      drafts?: DraftRecord[]
      thread?: Record<string, unknown>
      sendAs?: { sendAsEmail: string; isDefault?: boolean }[]
      sendAsScope?: boolean
      attachment?: { data: string; size: number }
    } = {},
  ) {
    const drafts = new Map((options.drafts ?? []).map((d) => [d.id, { ...d }]))
    const calls: { method: string; url: string; body?: unknown }[] = []
    let nextId = drafts.size + 1

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const path = new URL(url).pathname
      const body =
        init?.body === undefined
          ? undefined
          : (JSON.parse(String(init.body)) as Record<string, unknown>)
      calls.push({ method, url, body })

      const rawOf = (b: Record<string, unknown> | undefined): string | undefined =>
        (b?.message as { raw?: string } | undefined)?.raw ?? (b?.raw as string | undefined)

      // Gmail's own refusals, in the order it applies them.
      const raw = rawOf(body)
      if (raw !== undefined) {
        if (!/^[A-Za-z0-9_-]+$/.test(raw)) return refuse(400, 'invalidArgument')
        // A message with no recipient is refused at send, not at draft.
        if (path.endsWith('/messages/send') && headerIn(decode(raw), 'To') === '') {
          return refuse(400, 'invalidArgument')
        }
      }

      if (path.endsWith('/settings/sendAs')) {
        if (options.sendAsScope === false) return refuse(403, 'insufficientPermissions')
        return ok({ sendAs: options.sendAs ?? [{ sendAsEmail: 'Ada@syv.ai', isDefault: true }] })
      }

      if (path.includes('/attachments/')) {
        return ok(options.attachment ?? { data: 'AAEC', size: 3 })
      }

      if (path.endsWith('/drafts') && method === 'POST') {
        const id = `d-${nextId++}`
        const threadId = (body?.message as { threadId?: string } | undefined)?.threadId
        drafts.set(id, { id, raw: raw!, ...(threadId === undefined ? {} : { threadId }) })
        return ok({ id, message: { id: `m-${id}`, threadId } })
      }

      if (path.endsWith('/drafts') && method === 'GET') {
        return ok({
          drafts: [...drafts.values()].map((d) => ({
            id: d.id,
            message: { id: `m-${d.id}`, threadId: d.threadId },
          })),
        })
      }

      if (path.endsWith('/drafts/send')) {
        const id = String((body as { id?: string } | undefined)?.id)
        if (!drafts.has(id)) return refuse(404, 'notFound')
        drafts.delete(id)
        return ok({ id: 'm-sent' })
      }

      const draftId = path.startsWith('/gmail/v1/users/me/drafts/')
        ? decodeURIComponent(path.split('/').pop()!)
        : null

      if (draftId !== null) {
        if (!drafts.has(draftId)) return refuse(404, 'notFound')
        if (method === 'PUT') {
          const threadId = (body?.message as { threadId?: string } | undefined)?.threadId
          drafts.set(draftId, {
            id: draftId,
            raw: raw!,
            ...(threadId === undefined ? {} : { threadId }),
          })
          return ok({ id: draftId })
        }
        if (method === 'DELETE') {
          drafts.delete(draftId)
          return { ok: true, status: 204, json: async () => ({}), text: async () => '' }
        }
        // A draft read comes back as a parsed message, not as `raw`.
        const record = drafts.get(draftId)!
        return ok({ id: draftId, message: messageFromRaw(record) })
      }

      return ok(options.thread ?? {})
    })

    const api = new GoogleApi({
      accessToken: async () => 'at-1',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    })
    return { api, calls, drafts }
  }

  /**
   * A part's bytes as `drafts.get` hands them over: base64url of the content
   * **after** its transfer encoding has been undone. Gmail decodes that itself,
   * so a part written base64 (which the text parts are, to keep a long
   * paragraph under the 998-octet line limit) comes back as plain text — and a
   * double that skipped this step would hand `readDraft` base64 and call it the
   * message.
   */
  function partData(content: string, encoding: string | undefined): string {
    const bytes =
      encoding?.toLowerCase() === 'base64'
        ? Buffer.from(content.replace(/\r\n/g, ''), 'base64')
        : Buffer.from(content, 'utf8')
    return bytes.toString('base64url')
  }

  /** Turn a stored `raw` back into the payload shape `drafts.get` returns, so
   *  `readDraft` is exercised against Gmail's actual response shape rather than
   *  against the bytes we happened to send. */
  function messageFromRaw(record: DraftRecord): Record<string, unknown> {
    const text = decode(record.raw)
    const [head = '', ...rest] = text.split('\r\n\r\n')
    const headers = head
      .split('\r\n')
      .map((line) => ({
        name: line.slice(0, line.indexOf(':')),
        value: line.slice(line.indexOf(':') + 1).trim(),
      }))
    const contentType = headerIn(text, 'Content-Type') ?? ''
    const body = rest.join('\r\n\r\n')

    if (contentType.startsWith('multipart/alternative')) {
      const boundary = /boundary="([^"]+)"/.exec(contentType)![1]!
      const chunks = body.split(`--${boundary}`).slice(1, -1)
      const parts = chunks.map((chunk) => {
        const [partHead = '', ...partRest] = chunk.replace(/^\r\n/, '').split('\r\n\r\n')
        return {
          mimeType: partHead.includes('text/html') ? 'text/html' : 'text/plain',
          body: {
            data: partData(
              partRest.join('\r\n\r\n'),
              /Content-Transfer-Encoding:\s*(\S+)/i.exec(partHead)?.[1],
            ),
          },
        }
      })
      return { id: `m-${record.id}`, threadId: record.threadId, payload: { headers, parts } }
    }

    return {
      id: `m-${record.id}`,
      threadId: record.threadId,
      payload: {
        headers,
        mimeType: 'text/plain',
        body: { data: partData(body, headerIn(text, 'Content-Transfer-Encoding') ?? undefined) },
      },
    }
  }

  const MAIL = { to: ['bo@example.com'], subject: 'Q2 budget', body: 'Here it is.' }

  const THREAD = {
    id: 't1',
    messages: [
      {
        id: 'm1',
        labelIds: ['INBOX'],
        internalDate: '1000',
        payload: {
          headers: [
            header('Message-ID', '<msg-1@mail.example>'),
            header('Subject', 'Q2 budget'),
            header('From', 'Bo Berg <bo@example.com>'),
            header('To', 'ada@syv.ai'),
          ],
        },
      },
      {
        id: 'm2',
        labelIds: ['INBOX'],
        internalDate: '2000',
        payload: {
          headers: [
            header('Message-ID', '<msg-2@mail.example>'),
            header('Subject', 'Re: Q2 budget'),
            header('From', 'Bo Berg <bo@example.com>'),
            header('To', 'ada@syv.ai'),
            header('Cc', 'Cec <cec@example.com>'),
          ],
        },
      },
    ],
  }

  describe('sendInThread', () => {
    it('threads on the whole References chain, not just the parent', async () => {
      const { api, calls } = composer({ thread: THREAD })

      await sendInThread(api, 't1', MAIL)

      const post = calls.find((c) => c.url.endsWith('/messages/send'))!
      const raw = decode((post.body as { raw: string }).raw)
      expect(headerIn(raw, 'References')).toBe('<msg-1@mail.example> <msg-2@mail.example>')
      expect(headerIn(raw, 'In-Reply-To')).toBe('<msg-2@mail.example>')
    })

    it('takes recipients from the caller, never from the thread', async () => {
      // The difference from `replyToThread`, and the reason both exist. The UI
      // has already shown the user chips they may have edited; deriving
      // recipients here would silently discard that edit.
      const { api, calls } = composer({ thread: THREAD })

      await sendInThread(api, 't1', { ...MAIL, to: ['someone@else.example'], cc: ['x@y.example'] })

      const post = calls.find((c) => c.url.endsWith('/messages/send'))!
      const raw = decode((post.body as { raw: string }).raw)
      expect(headerIn(raw, 'To')).toBe('someone@else.example')
      expect(headerIn(raw, 'Cc')).toBe('x@y.example')
      expect(raw).not.toContain('cec@example.com')
    })

    it('files the send into its thread by id as well as by header', async () => {
      const { api, calls } = composer({ thread: THREAD })

      await sendInThread(api, 't1', MAIL)

      const post = calls.find((c) => c.url.endsWith('/messages/send'))!
      expect((post.body as { threadId?: string }).threadId).toBe('t1')
    })

    it('reads the thread as metadata — the body is never needed to thread', async () => {
      const { api, calls } = composer({ thread: THREAD })

      await sendInThread(api, 't1', MAIL)

      const read = calls.find((c) => c.method === 'GET' && c.url.includes('/threads/'))!
      expect(read.url).toContain('format=metadata')
    })

    it('refuses a send with no recipient the way Google does', async () => {
      const { api } = composer({ thread: THREAD })

      await expect(sendInThread(api, 't1', { ...MAIL, to: [] })).rejects.toThrow()
    })
  })

  describe('saveDraft', () => {
    it('creates when there is no draftId, and files it in the thread', async () => {
      const { api, calls, drafts } = composer()

      const result = await saveDraft(api, MAIL, { threadId: 't1' })

      expect(result.id).toBe('d-1')
      expect(drafts.size).toBe(1)
      const post = calls.find((c) => c.method === 'POST')!
      expect((post.body as { message: { threadId?: string } }).message.threadId).toBe('t1')
    })

    it('updates in place when given a draftId, rather than making a second draft', async () => {
      // The failure this prevents: the user watches their message fork into two
      // drafts because every autosave created a new one.
      const { api, calls, drafts } = composer({ drafts: [{ id: 'd-1', raw: 'AAAA' }] })

      const result = await saveDraft(api, MAIL, { draftId: 'd-1' })

      expect(result.id).toBe('d-1')
      expect(drafts.size).toBe(1)
      expect(calls.some((c) => c.method === 'PUT')).toBe(true)
      expect(calls.some((c) => c.method === 'POST')).toBe(false)
    })

    it('carries the threading headers on every save, not only on send', async () => {
      // `drafts.update` REPLACES the draft, so a save that omits them strips
      // them — and a draft sent later from a phone starts a new thread.
      const { api, calls } = composer({ drafts: [{ id: 'd-1', raw: 'AAAA' }], thread: THREAD })

      await saveDraft(api, MAIL, { draftId: 'd-1', threadId: 't1' })

      const put = calls.find((c) => c.method === 'PUT')!
      const raw = decode((put.body as { message: { raw: string } }).message.raw)
      expect(headerIn(raw, 'References')).toBe('<msg-1@mail.example> <msg-2@mail.example>')
    })

    it('reports a 404 on an unknown draft rather than silently creating one', async () => {
      const { api } = composer()

      await expect(saveDraft(api, MAIL, { draftId: 'gone' })).rejects.toMatchObject({
        code: 'not-found',
      })
    })

    it('does not read the thread when the draft belongs to no thread', async () => {
      const { api, calls } = composer()

      await saveDraft(api, MAIL, {})

      expect(calls.some((c) => c.url.includes('/threads/'))).toBe(false)
    })
  })

  describe('sendDraft', () => {
    it('sends through drafts/send so Gmail deletes the draft atomically', async () => {
      // messages.send + drafts.delete leaves an orphan draft whenever the second
      // call fails — a message the user already sent, still sitting in Drafts.
      const { api, calls, drafts } = composer({ drafts: [{ id: 'd-1', raw: 'AAAA' }] })

      const result = await sendDraft(api, 'd-1')

      expect(calls.some((c) => c.url.endsWith('/drafts/send'))).toBe(true)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      expect(drafts.size).toBe(0)
      expect(result.id).toBe('m-sent')
    })
  })

  describe('deleteDraft', () => {
    it('deletes', async () => {
      const { api, drafts } = composer({ drafts: [{ id: 'd-1', raw: 'AAAA' }] })

      await deleteDraft(api, 'd-1')

      expect(drafts.size).toBe(0)
    })
  })

  describe('listSendAs', () => {
    it('lowercases the addresses, because they are compared against headers', async () => {
      const { api } = composer({ sendAs: [{ sendAsEmail: 'Ada@Syv.ai', isDefault: true }] })

      expect(await listSendAs(api)).toEqual(['ada@syv.ai'])
    })

    it('returns one entry for an account with no aliases, not zero', async () => {
      const { api } = composer()

      expect(await listSendAs(api)).toHaveLength(1)
    })

    it('returns every alias, so reply-all can exclude all of them', async () => {
      const { api } = composer({
        sendAs: [
          { sendAsEmail: 'ada@syv.ai', isDefault: true },
          { sendAsEmail: 'ada.holm@syv.ai' },
        ],
      })

      expect(await listSendAs(api)).toEqual(['ada@syv.ai', 'ada.holm@syv.ai'])
    })

    it('surfaces a missing scope as `scope`, not as an empty list', async () => {
      // An empty list would silently turn every reply-all into one that copies
      // the user on their own message.
      const { api } = composer({ sendAsScope: false })

      await expect(listSendAs(api)).rejects.toMatchObject({ code: 'scope' })
    })
  })

  describe('fetchAttachment', () => {
    it('converts base64url to standard base64', async () => {
      // `attachments.get` answers base64url; MIME needs standard base64. The two
      // differ in three characters, and forgetting it produces a file that opens
      // as garbage — visible only to the recipient.
      const bytes = Buffer.from([0xfb, 0xef, 0xbe])
      const { api } = composer({
        attachment: { data: bytes.toString('base64url'), size: bytes.length },
      })

      const part = await fetchAttachment(api, 'm1', 'a1', {
        filename: 'q2.pdf',
        mimeType: 'application/pdf',
      })

      expect(part.data).toBe(bytes.toString('base64'))
      expect(part.data).toMatch(/[+/]/)
      expect(Buffer.from(part.data, 'base64')).toEqual(bytes)
    })

    it('carries the filename and type through, since the wire answer has neither', async () => {
      const { api } = composer()

      const part = await fetchAttachment(api, 'm1', 'a1', {
        filename: 'q2.pdf',
        mimeType: 'application/pdf',
      })

      expect(part.filename).toBe('q2.pdf')
      expect(part.mimeType).toBe('application/pdf')
    })
  })

  describe('listDrafts', () => {
    it('summarises each draft with who it is to and what it says', async () => {
      const { api } = composer({
        drafts: [{ id: 'd-1', threadId: 't1', raw: toBase64Url(buildRfc822(MAIL)) }],
      })

      const [draft] = await listDrafts(api)

      expect(draft!.draftId).toBe('d-1')
      expect(draft!.threadId).toBe('t1')
      expect(draft!.subject).toBe('Q2 budget')
      expect(draft!.to.map((a) => a.email)).toEqual(['bo@example.com'])
    })

    it('reports a draft with no recipient as an empty list, not a fabricated one', async () => {
      const raw = toBase64Url(buildRfc822({ ...MAIL, to: [] }))
      const { api } = composer({ drafts: [{ id: 'd-1', raw }] })

      const [draft] = await listDrafts(api)

      expect(draft!.to).toEqual([])
      expect(draft!.threadId).toBeNull()
    })
  })

  describe('readDraft', () => {
    it('reads a draft Holi wrote back byte-exact, because of the marker', async () => {
      const markdown = '**bold** and a [link](https://syv.ai)'
      const raw = toBase64Url(buildRfc822({ ...MAIL, body: markdown, html: '<p>rendered</p>' }))
      const { api } = composer({ drafts: [{ id: 'd-1', threadId: 't1', raw }] })

      const draft = await readDraft(api, 'd-1')

      expect(draft.foreign).toBe(false)
      expect(draft.markdown).toBe(markdown)
      expect(draft.subject).toBe('Q2 budget')
      expect(draft.text).toBe(markdown)
      expect(draft.to.map((a) => a.email)).toEqual(['bo@example.com'])
    })

    it('marks a draft written elsewhere as foreign, with no markdown to trust', async () => {
      // `markdown: null` is the instruction to the renderer to convert. Main
      // cannot do it: turndown needs a DOM and main has none.
      const raw = toBase64Url(
        [
          'To: bo@example.com',
          'Subject: Written in Gmail',
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset="UTF-8"',
          '',
          'plain words',
        ].join('\r\n'),
      )
      const { api } = composer({ drafts: [{ id: 'd-1', raw }] })

      const draft = await readDraft(api, 'd-1')

      expect(draft.foreign).toBe(true)
      expect(draft.markdown).toBeNull()
      // No `text/html` part at all — so "convert the html" would convert
      // nothing. The plain text IS the message, and it travels for that case:
      // this is the shape of every draft the agent wrote before the marker
      // existed, and of anything from a plain-text client.
      expect(draft.html).toBeNull()
      expect(draft.text).toBe('plain words')
    })

    /**
     * "Byte-exact" has to include the bytes nobody looks at.
     *
     * `replyBody` opens with two blank lines so the cursor sits above the quoted
     * original. Trimming on the way back in deletes exactly that: the user saves
     * a half-written reply, reopens it, and their writing space is gone with
     * their text flush against the `---`. It reads as the editor eating input.
     */
    it('preserves the leading blank lines a reply is written into', async () => {
      const markdown = '\n\nmy answer\n\n---\n\n> what they wrote\n'
      const raw = toBase64Url(buildRfc822({ ...MAIL, body: markdown, html: '<p>x</p>' }))
      const { api } = composer({ drafts: [{ id: 'd-1', threadId: 't1', raw }] })

      const draft = await readDraft(api, 'd-1')

      expect(draft.markdown).toBe(markdown)
    })

    it('carries cc, which is what a reply-all draft is for', async () => {
      const raw = toBase64Url(buildRfc822({ ...MAIL, cc: ['cec@example.com'] }))
      const { api } = composer({ drafts: [{ id: 'd-1', raw }] })

      expect((await readDraft(api, 'd-1')).cc.map((a) => a.email)).toEqual(['cec@example.com'])
    })

    it('reports a 404 for a draft that is gone', async () => {
      const { api } = composer()

      await expect(readDraft(api, 'gone')).rejects.toMatchObject({ code: 'not-found' })
    })
  })
})

/**
 * Forwarding the original's attachments (D71).
 *
 * The bytes are fetched HERE, in main, from a message id the renderer supplied.
 * That is what buys a forward that carries its files with no file picker, no
 * base64 in renderer state, and no size cap to design.
 */
describe('fetchMessageAttachments', () => {
  function messageWith(payload: unknown, data = 'AAEC') {
    const fetchImpl = vi.fn(async (url: string) => {
      const body = new URL(url).pathname.includes('/attachments/')
        ? { data, size: 3 }
        : { id: 'm1', payload }
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      }
    })
    return new GoogleApi({
      accessToken: async () => 'at',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    })
  }

  it('finds an attachment however deeply nested, and fetches its bytes', async () => {
    const api = messageWith({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: 'aGk' } },
        {
          mimeType: 'multipart/related',
          parts: [
            {
              filename: 'q2.pdf',
              mimeType: 'application/pdf',
              body: { attachmentId: 'a1', size: 3 },
            },
          ],
        },
      ],
    })

    const parts = await fetchMessageAttachments(api, 'm1')

    expect(parts).toHaveLength(1)
    expect(parts[0]!.filename).toBe('q2.pdf')
    expect(parts[0]!.mimeType).toBe('application/pdf')
  })

  it('converts the bytes to standard base64 on the way through', async () => {
    const bytes = Buffer.from([0xfb, 0xef, 0xbe])
    const api = messageWith(
      {
        parts: [
          { filename: 'x.bin', mimeType: 'application/octet-stream', body: { attachmentId: 'a1' } },
        ],
      },
      bytes.toString('base64url'),
    )

    const [part] = await fetchMessageAttachments(api, 'm1')

    expect(part!.data).toBe(bytes.toString('base64'))
  })

  it('ignores a body part, which has no attachmentId', async () => {
    // An inline text part is not a file, and a forward that attached the
    // message body as a download would be nonsense.
    const api = messageWith({
      parts: [{ mimeType: 'text/plain', body: { data: 'aGk' } }],
    })

    expect(await fetchMessageAttachments(api, 'm1')).toEqual([])
  })

  it('returns nothing for a message with no attachments at all', async () => {
    // The empty case matters: `data.ts` leaves `attachments` absent for it, so
    // the forward takes the multipart/alternative path rather than building an
    // empty multipart/mixed.
    const api = messageWith({ mimeType: 'text/plain', body: { data: 'aGk' } })

    expect(await fetchMessageAttachments(api, 'm1')).toEqual([])
  })
})
