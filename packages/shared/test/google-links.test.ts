/**
 * Detecting Google links in a body.
 *
 * The interesting cases are the false positives: a URL that merely *mentions*
 * a Google host, and a look-alike domain. Claiming either would put a "calendar
 * event" chip on someone's phishing link.
 */
import { describe, expect, it } from 'vitest'
import { googleLinkKind, googleLinksIn } from '../src/google-links'

const EVENT = 'https://calendar.google.com/calendar/event?eid=abc'
const MAIL = 'https://mail.google.com/mail/u/0/#search/rfc822msgid:x%40y.z'

describe('googleLinkKind', () => {
  it('recognises calendar and mail', () => {
    expect(googleLinkKind(EVENT)).toBe('calendar')
    expect(googleLinkKind(MAIL)).toBe('mail')
  })

  it('ignores every other host', () => {
    expect(googleLinkKind('https://github.com/syv-ai/holi')).toBeNull()
    expect(googleLinkKind('https://docs.google.com/document/d/1')).toBeNull()
  })

  it('is not fooled by a Google host inside another URL', () => {
    // Substring matching would call this a calendar link.
    expect(googleLinkKind('https://evil.example.com/?next=calendar.google.com')).toBeNull()
  })

  it('is not fooled by a look-alike domain', () => {
    expect(googleLinkKind('https://mail.google.com.evil.example/x')).toBeNull()
    expect(googleLinkKind('https://notmail.google.com/x')).toBeNull()
  })

  it('returns null for something that is not a URL at all', () => {
    expect(googleLinkKind('not a url')).toBeNull()
    expect(googleLinkKind('')).toBeNull()
  })
})

describe('googleLinksIn', () => {
  it('finds a named markdown link and keeps its title', () => {
    expect(googleLinksIn(`Prep for [Q2 review](${EVENT}) tomorrow.`)).toEqual([
      { kind: 'calendar', title: 'Q2 review', url: EVENT },
    ])
  })

  it('finds several, in the order written, keeping duplicates', () => {
    const body = `[a](${EVENT})\n[b](${MAIL})\n[a again](${EVENT})`

    expect(googleLinksIn(body).map((l) => l.kind)).toEqual(['calendar', 'mail', 'calendar'])
  })

  it('ignores non-Google links in the same body', () => {
    const body = `see [the repo](https://github.com/x) and [the event](${EVENT})`

    expect(googleLinksIn(body)).toHaveLength(1)
  })

  it('leaves a bare URL alone — it is not a link the author named', () => {
    expect(googleLinksIn(`the event is at ${EVENT}`)).toEqual([])
  })

  it('returns nothing for an empty body', () => {
    expect(googleLinksIn('')).toEqual([])
  })
})
