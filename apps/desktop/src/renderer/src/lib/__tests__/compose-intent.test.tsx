/**
 * The compose intent (D71).
 *
 * A discriminated union rather than a query string, because ultramail's finding
 * was that a typo in the kind silently produced an empty composer — no error,
 * no clue, just a blank message where a reply should have been.
 *
 * Everything here is a rule about who receives a message, which is the class of
 * bug that is invisible to the sender and obvious to everybody else on the
 * thread.
 */
import { describe, expect, it } from 'vitest'
import { composeFrom, type ComposeIntent } from '../compose-intent'
import type { ThreadMessage } from '../mail-types'

const SELF = ['ada@syv.ai', 'ada.holm@syv.ai']

function message(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'm1',
    from: { name: 'Bo Berg', email: 'bo@example.com' },
    to: [{ name: 'Ada Holm', email: 'ada@syv.ai' }],
    cc: [],
    date: '2026-08-12T08:30:00.000Z',
    body: 'The numbers are attached.',
    html: null,
    attachments: [],
    ...overrides,
  }
}

function reply(overrides: Partial<ThreadMessage> = {}, all = false): ComposeIntent {
  return { kind: 'reply', threadId: 't1', subject: 'Q2 budget', parent: message(overrides), all }
}

describe('composeFrom — new', () => {
  it('is empty in every field', () => {
    expect(composeFrom({ kind: 'new' }, SELF)).toEqual({ to: [], cc: [], subject: '', body: '' })
  })
})

describe('composeFrom — subject', () => {
  it('prefixes a reply with Re:', () => {
    expect(composeFrom(reply(), SELF).subject).toBe('Re: Q2 budget')
  })

  it('does not double the prefix — Re: Re: is what a naive prefix produces', () => {
    const intent = { ...reply(), subject: 'Re: Q2 budget' } as ComposeIntent

    expect(composeFrom(intent, SELF).subject).toBe('Re: Q2 budget')
  })

  it('leaves a subject that was already Re: Re: alone rather than tidying it', () => {
    // Idempotent, not normalising. Rewriting somebody else's subject line
    // changes what the thread is called for every participant.
    const intent = { ...reply(), subject: 'Re: Re: Q2 budget' } as ComposeIntent

    expect(composeFrom(intent, SELF).subject).toBe('Re: Re: Q2 budget')
  })

  it('matches the prefix case-insensitively', () => {
    const intent = { ...reply(), subject: 'RE: Q2 budget' } as ComposeIntent

    expect(composeFrom(intent, SELF).subject).toBe('RE: Q2 budget')
  })

  it('prefixes a forward with Fwd:, idempotently', () => {
    const forward: ComposeIntent = {
      kind: 'forward',
      threadId: 't1',
      subject: 'Q2 budget',
      parent: message(),
    }

    expect(composeFrom(forward, SELF).subject).toBe('Fwd: Q2 budget')
    expect(composeFrom({ ...forward, subject: 'Fwd: Q2 budget' }, SELF).subject).toBe(
      'Fwd: Q2 budget',
    )
  })

  it('handles an empty subject without leaving a dangling prefix', () => {
    const intent = { ...reply(), subject: '' } as ComposeIntent

    expect(composeFrom(intent, SELF).subject).toBe('Re:')
  })
})

describe('composeFrom — recipients', () => {
  it('replies to the sender, and copies nobody', () => {
    const draft = composeFrom(reply({ cc: [{ name: 'Cec', email: 'cec@example.com' }] }), SELF)

    expect(draft.to).toEqual([{ name: 'Bo Berg', email: 'bo@example.com' }])
    expect(draft.cc).toEqual([])
  })

  it('reply-all copies To and Cc together', () => {
    const draft = composeFrom(
      reply(
        {
          to: [
            { name: 'Ada Holm', email: 'ada@syv.ai' },
            { name: 'Dan', email: 'dan@example.com' },
          ],
          cc: [{ name: 'Cec', email: 'cec@example.com' }],
        },
        true,
      ),
      SELF,
    )

    expect(draft.to).toEqual([{ name: 'Bo Berg', email: 'bo@example.com' }])
    expect(draft.cc.map((a) => a.email)).toEqual(['dan@example.com', 'cec@example.com'])
  })

  it('reply-all excludes every alias in self, not just the connected address', () => {
    // The alias half is the one that breaks: replying to a message addressed to
    // an alias copies the user on their own reply, and it looks like a bug in
    // the recipient's client rather than in ours.
    const draft = composeFrom(
      reply(
        {
          to: [
            { name: 'Ada', email: 'ada@syv.ai' },
            { name: 'Ada alias', email: 'ada.holm@syv.ai' },
            { name: 'Dan', email: 'dan@example.com' },
          ],
        },
        true,
      ),
      SELF,
    )

    expect(draft.cc.map((a) => a.email)).toEqual(['dan@example.com'])
  })

  it('dedupes case-insensitively — Ada@syv.ai and ada@syv.ai are one person', () => {
    const draft = composeFrom(
      reply(
        {
          to: [
            { name: 'Dan', email: 'Dan@Example.com' },
            { name: 'Dan again', email: 'dan@example.com' },
          ],
          cc: [{ name: 'Dan thrice', email: 'DAN@EXAMPLE.COM' }],
        },
        true,
      ),
      SELF,
    )

    expect(draft.cc).toHaveLength(1)
  })

  it('excludes the reply-to address from cc, so nobody is mailed twice', () => {
    const draft = composeFrom(
      reply({ cc: [{ name: 'Bo Berg', email: 'bo@example.com' }] }, true),
      SELF,
    )

    expect(draft.to.map((a) => a.email)).toEqual(['bo@example.com'])
    expect(draft.cc).toEqual([])
  })

  it('drops an address the header carried no address for', () => {
    // Rendering it as a chip would offer the user something unmailable, and
    // sending it would fail at Google with a message about a header.
    const to = [
      { name: 'Nobody', email: '' },
      { name: 'Dan', email: 'dan@example.com' },
    ]

    const draft = composeFrom(reply({ to }, true), SELF)

    expect(draft.cc.map((a) => a.email)).toEqual(['dan@example.com'])
  })

  it('still addresses the sender when replying to your own message', () => {
    // Subtracting `self` from `to` as well would leave no recipient at all, a
    // disabled Send, and nothing on screen saying why. An address the user can
    // see and edit is recoverable; a silently empty field is not.
    const draft = composeFrom(reply({ from: { name: 'Ada Holm', email: 'ada@syv.ai' } }), SELF)

    expect(draft.to.map((a) => a.email)).toEqual(['ada@syv.ai'])
  })

  it('replies with no recipient when the parent had no usable From', () => {
    const draft = composeFrom(reply({ from: { name: 'Ghost', email: '' } }), SELF)

    expect(draft.to).toEqual([])
  })

  it('forwards to nobody', () => {
    const forward: ComposeIntent = {
      kind: 'forward',
      threadId: 't1',
      subject: 'Q2 budget',
      parent: message({ cc: [{ name: 'Cec', email: 'cec@example.com' }] }),
    }

    const draft = composeFrom(forward, SELF)

    expect(draft.to).toEqual([])
    expect(draft.cc).toEqual([])
  })
})

describe('composeFrom — the quoted body', () => {
  it('leaves the cursor on line 1, above the attribution', () => {
    const body = composeFrom(reply(), SELF).body

    expect(body.startsWith('\n\n')).toBe(true)
  })

  it('attributes the quote to the parent sender', () => {
    const body = composeFrom(reply(), SELF).body

    expect(body).toContain('Bo Berg')
    expect(body).toMatch(/wrote:/)
    expect(body).toContain('2026')
  })

  it('quotes the plain body when there is no html', () => {
    const body = composeFrom(reply({ body: 'line one\nline two' }), SELF).body

    expect(body).toContain('> line one\n> line two')
  })

  it('quotes real markdown when the parent exists only as html', () => {
    // The correction §5 needed: a quoted table stays a table, which a
    // blockquote of `bodyTextOf` could never manage.
    const html =
      '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'

    const body = composeFrom(reply({ body: 'a 1', html }), SELF).body

    expect(body).toContain('> | a |')
    expect(body).toContain('> | 1 |')
  })

  it('prefers the html over the plain body when both are present', () => {
    const body = composeFrom(reply({ body: 'plain fallback', html: '<p><em>rich</em></p>' }), SELF)
      .body

    expect(body).toContain('_rich_')
    expect(body).not.toContain('plain fallback')
  })

  it('quotes an attribution alone when the parent has neither body nor html', () => {
    const body = composeFrom(reply({ body: '', html: null }), SELF).body

    expect(body).toContain('wrote:')
    // Not a lone `>` dangling under the attribution.
    expect(body).not.toMatch(/^>\s*$/m)
  })

  it('marks a forward as forwarded rather than as something somebody wrote to you', () => {
    const forward: ComposeIntent = {
      kind: 'forward',
      threadId: 't1',
      subject: 'Q2 budget',
      parent: message(),
    }

    const body = composeFrom(forward, SELF).body

    expect(body).toContain('Forwarded message')
    expect(body).toContain('bo@example.com')
    expect(body).toContain('Q2 budget')
  })

  it('survives a date it cannot parse rather than rendering Invalid Date', () => {
    const body = composeFrom(reply({ date: 'not a date' }), SELF).body

    expect(body).not.toContain('Invalid Date')
    expect(body).toContain('wrote:')
  })
})
