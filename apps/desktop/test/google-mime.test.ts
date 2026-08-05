/**
 * RFC-822 assembly — the pure half of sending mail, and the half that is
 * easiest to get silently wrong.
 *
 * Every case here is a bug that a naive fake would have passed. A reply with
 * `In-Reply-To` and no `References` sends fine, returns an id, and lands as a
 * new thread. A subject with `æøå` sends fine and arrives as mojibake. Plain
 * base64 instead of base64url is rejected by Gmail, but only at the point where
 * a human is waiting for the mail to go.
 */
import { describe, expect, it } from 'vitest'
import { buildRfc822, toBase64Url } from '../src/main/google/mime'

const BASE = { to: ['ada@syv.ai'], subject: 'Q2 budget', body: 'Here it is.' }

/** Headers, as a lookup. Header names are case-insensitive; values may be
 *  folded across lines, which this deliberately does not handle — no header
 *  written here is long enough to fold, and a test that unfolds would hide it
 *  if one became so. */
function headersOf(raw: string): Record<string, string> {
  const [head] = raw.split('\r\n\r\n')
  const out: Record<string, string> = {}
  for (const line of head!.split('\r\n')) {
    const at = line.indexOf(':')
    if (at > 0) out[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim()
  }
  return out
}

function bodyOf(raw: string): string {
  return raw.split('\r\n\r\n').slice(1).join('\r\n\r\n')
}

describe('buildRfc822', () => {
  it('writes the headers a message needs, separated from the body by a blank line', () => {
    const raw = buildRfc822(BASE)
    const h = headersOf(raw)

    expect(h.to).toBe('ada@syv.ai')
    expect(h.subject).toBe('Q2 budget')
    expect(bodyOf(raw)).toBe('Here it is.')
  })

  it('separates headers with CRLF, not bare newlines', () => {
    // `\n` alone is out of spec. Some servers accept it; the ones that do not
    // reject the whole message.
    const raw = buildRfc822(BASE)

    expect(raw).toContain('\r\n')
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('joins several recipients with commas, and carries cc', () => {
    const raw = buildRfc822({ ...BASE, to: ['ada@syv.ai', 'bo@syv.ai'], cc: ['cec@syv.ai'] })
    const h = headersOf(raw)

    expect(h.to).toBe('ada@syv.ai, bo@syv.ai')
    expect(h.cc).toBe('cec@syv.ai')
  })

  // The one that matters most. With In-Reply-To alone, Gmail starts a NEW
  // thread — and every assertion short of reading both headers passes anyway.
  it('carries In-Reply-To AND References on a reply', () => {
    const raw = buildRfc822({
      ...BASE,
      inReplyTo: '<msg-2@mail.gmail.com>',
      references: ['<msg-1@mail.gmail.com>', '<msg-2@mail.gmail.com>'],
    })
    const h = headersOf(raw)

    expect(h['in-reply-to']).toBe('<msg-2@mail.gmail.com>')
    expect(h.references).toBe('<msg-1@mail.gmail.com> <msg-2@mail.gmail.com>')
  })

  it('declares a UTF-8 body so a Danish sentence is not mojibake', () => {
    const raw = buildRfc822({ ...BASE, body: 'Vi ses på mødet i går — hilsen Ada' })
    const h = headersOf(raw)

    expect(h['content-type']).toMatch(/text\/plain/)
    expect(h['content-type']).toMatch(/charset="?UTF-8"?/i)
    expect(raw).toContain('Vi ses på mødet i går — hilsen Ada')
  })

  it('encodes a non-ASCII subject as an RFC 2047 word', () => {
    // A raw `æ` in a header is not legal and does not survive every hop.
    const raw = buildRfc822({ ...BASE, subject: 'Møde på tirsdag' })
    const h = headersOf(raw)

    expect(h.subject).toMatch(/^=\?UTF-8\?B\?.+\?=$/)
    expect(h.subject).not.toContain('ø')
    // and it round-trips
    const encoded = h.subject!.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '')
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('Møde på tirsdag')
  })

  it('leaves a plain ASCII subject alone', () => {
    expect(headersOf(buildRfc822(BASE)).subject).toBe('Q2 budget')
  })

  // The agent composes these strings out of user prose. A newline in a subject
  // is how you smuggle a Bcc header into someone else's message.
  it('rejects a newline in a header rather than sanitising it', () => {
    expect(() => buildRfc822({ ...BASE, subject: 'Hi\r\nBcc: eve@evil.example' })).toThrow(
      /newline/i,
    )
    expect(() => buildRfc822({ ...BASE, subject: 'Hi\nBcc: eve@evil.example' })).toThrow(/newline/i)
    expect(() => buildRfc822({ ...BASE, to: ['ada@syv.ai\r\nBcc: eve@evil.example'] })).toThrow(
      /newline/i,
    )
  })

  it('does not reject a newline in the body — that is just a paragraph', () => {
    expect(() => buildRfc822({ ...BASE, body: 'One.\n\nTwo.' })).not.toThrow()
  })
})

describe('toBase64Url', () => {
  it('uses the URL alphabet and drops the padding', () => {
    // Chosen so standard base64 produces both a '+' and a '/', plus padding.
    const text = 'ÿï¾'

    const out = toBase64Url(text)

    expect(out).not.toMatch(/[+/=]/)
  })

  it('round-trips a built message byte for byte', () => {
    const raw = buildRfc822({ ...BASE, body: 'Vi ses på mødet — Ada' })

    const decoded = Buffer.from(toBase64Url(raw), 'base64url').toString('utf8')

    expect(decoded).toBe(raw)
  })

  it('encodes non-ASCII as UTF-8 bytes, not as code units', () => {
    // 'ø' is two bytes in UTF-8. Encoding via latin1/charCode loses it.
    const decoded = Buffer.from(toBase64Url('ø'), 'base64url')

    expect([...decoded]).toEqual([0xc3, 0xb8])
  })
})
