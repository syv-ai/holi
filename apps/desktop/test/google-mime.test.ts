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

/**
 * A generator that hands out fixed boundaries in order, so a test can assert
 * where each one landed. The real one is crypto-random and unassertable.
 */
function fixedBoundaries(...names: string[]): () => string {
  let next = 0
  return () => names[next++] ?? `exhausted-${next}`
}

/** The block between two `--boundary` delimiters, by index. */
function partsOf(raw: string, boundary: string): string[] {
  return raw
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => part.replace(/^\r\n/, ''))
}

describe('buildRfc822 — the marker', () => {
  // Written unconditionally, because the agent's plain-text sends are markdown
  // too. It is what makes a draft the agent wrote editable in Holi's composer.
  it('writes X-Holi-Source on a single-part message', () => {
    expect(headersOf(buildRfc822(BASE))['x-holi-source']).toBe('markdown')
  })

  it('writes X-Holi-Source on an alternative message', () => {
    const raw = buildRfc822({ ...BASE, html: '<p>Here it is.</p>' })

    expect(headersOf(raw)['x-holi-source']).toBe('markdown')
  })

  it('writes X-Holi-Source on a mixed message', () => {
    const raw = buildRfc822({
      ...BASE,
      html: '<p>Here it is.</p>',
      attachments: [{ filename: 'q2.pdf', mimeType: 'application/pdf', data: 'AAEC' }],
    })

    expect(headersOf(raw)['x-holi-source']).toBe('markdown')
  })
})

describe('buildRfc822 — single part, unchanged', () => {
  /**
   * The agent's `holi-google send` still takes this path, so its shape is
   * pinned byte for byte. The one difference from before the composer landed is
   * the `X-Holi-Source` line; everything else — order, spelling, CRLF, the blank
   * line before the body — is asserted here rather than described.
   */
  it('is byte-exact when neither html nor attachments are supplied', () => {
    expect(buildRfc822(BASE)).toBe(
      [
        'To: ada@syv.ai',
        'Subject: Q2 budget',
        'MIME-Version: 1.0',
        'X-Holi-Source: markdown',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        'Here it is.',
      ].join('\r\n'),
    )
  })

  it('takes the single-part path when attachments is present but empty', () => {
    // A forward of a message that had none. An empty multipart/mixed is legal
    // and displays as a message with a mysterious missing attachment.
    expect(buildRfc822({ ...BASE, attachments: [] })).toBe(buildRfc822(BASE))
  })
})

describe('buildRfc822 — multipart/alternative', () => {
  const MAIL = { ...BASE, body: 'Here it is.', html: '<p>Here it is.</p>' }

  it('declares multipart/alternative with the generated boundary', () => {
    const h = headersOf(buildRfc822(MAIL, fixedBoundaries('ALT')))

    expect(h['content-type']).toBe('multipart/alternative; boundary="ALT"')
    // The top-level Content-Transfer-Encoding of a multipart message is 7bit;
    // 8bit belongs on the leaf parts, and a multipart is not itself encoded.
    expect(h['content-transfer-encoding']).toBe('7bit')
  })

  // Reversed, every client that prefers the LAST acceptable part shows the
  // plain text — which is the whole feature silently not working.
  it('puts text/plain before text/html', () => {
    const parts = partsOf(buildRfc822(MAIL, fixedBoundaries('ALT')), 'ALT')

    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatch(/^Content-Type: text\/plain; charset="UTF-8"/)
    expect(parts[1]).toMatch(/^Content-Type: text\/html; charset="UTF-8"/)
  })

  it('carries the markdown in the plain part and the html in the html part', () => {
    const parts = partsOf(buildRfc822(MAIL, fixedBoundaries('ALT')), 'ALT')

    expect(parts[0]).toContain('\r\n\r\nHere it is.')
    expect(parts[1]).toContain('\r\n\r\n<p>Here it is.</p>')
  })

  it('declares UTF-8 and 8bit on both parts, so Danish survives either way', () => {
    const danish = { ...MAIL, body: 'på mødet', html: '<p>på mødet</p>' }
    const parts = partsOf(buildRfc822(danish, fixedBoundaries('ALT')), 'ALT')

    for (const part of parts) {
      expect(part).toMatch(/charset="UTF-8"/)
      expect(part).toMatch(/Content-Transfer-Encoding: 8bit/)
      expect(part).toContain('på mødet')
    }
  })

  it('closes with the terminating delimiter, CRLF throughout', () => {
    const raw = buildRfc822(MAIL, fixedBoundaries('ALT'))

    expect(raw).toContain('\r\n--ALT--\r\n')
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('regenerates a boundary that occurs in a part, rather than hoping', () => {
    // A quoted parent that itself contains a MIME delimiter is not exotic —
    // forwarding a forward produces one. The collision truncates the message at
    // the point of the collision, and only the recipient ever sees it.
    const raw = buildRfc822(
      { ...MAIL, body: 'delimiters: --COLLIDE and --ALSO-COLLIDE, apparently' },
      fixedBoundaries('COLLIDE', 'ALSO-COLLIDE', 'SAFE'),
    )

    expect(headersOf(raw)['content-type']).toBe('multipart/alternative; boundary="SAFE"')
    expect(partsOf(raw, 'SAFE')).toHaveLength(2)
  })

  it('rejects an empty html part when there was body text to render', () => {
    // A render that produced nothing from prose that exists is a bug upstream,
    // and it reaches the recipient as a blank message. Caught here because this
    // is the last place that sees both halves.
    expect(() => buildRfc822({ ...BASE, html: '' })).toThrow(/html/i)
  })

  it('sends an empty message as a single part rather than refusing it', () => {
    // An empty body is allowed to send (D71), so `renderMailMarkdown('')`
    // returning '' is not the bug above — there was nothing to render.
    const raw = buildRfc822({ ...BASE, body: '', html: '' })

    expect(headersOf(raw)['content-type']).toBe('text/plain; charset="UTF-8"')
  })
})

describe('buildRfc822 — multipart/mixed', () => {
  const PDF = { filename: 'q2.pdf', mimeType: 'application/pdf', data: 'AAECAwQ=' }
  const MAIL = { ...BASE, html: '<p>Here it is.</p>', attachments: [PDF] }

  it('wraps the alternative as the first part of the mixed message', () => {
    const raw = buildRfc822(MAIL, fixedBoundaries('ALT', 'MIX'))
    const h = headersOf(raw)

    expect(h['content-type']).toBe('multipart/mixed; boundary="MIX"')

    const parts = partsOf(raw, 'MIX')
    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatch(/^Content-Type: multipart\/alternative; boundary="ALT"/)
    expect(partsOf(parts[0]!, 'ALT')).toHaveLength(2)
  })

  it('attaches the file with a filename, a disposition and base64 encoding', () => {
    const attachment = partsOf(buildRfc822(MAIL, fixedBoundaries('ALT', 'MIX')), 'MIX')[1]!

    expect(attachment).toMatch(/Content-Type: application\/pdf; name="q2.pdf"/)
    expect(attachment).toMatch(/Content-Disposition: attachment; filename="q2.pdf"/)
    expect(attachment).toMatch(/Content-Transfer-Encoding: base64/)
    expect(attachment).toContain('\r\n\r\nAAECAwQ=')
  })

  it('wraps base64 at 76 columns', () => {
    // Some servers reject a line over 998 octets outright; others silently
    // truncate. Either way the recipient gets a file that will not open.
    const long = { ...PDF, data: 'A'.repeat(500) }
    const attachment = partsOf(
      buildRfc822({ ...MAIL, attachments: [long] }, fixedBoundaries('ALT', 'MIX')),
      'MIX',
    )[1]!
    const lines = attachment.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim().split('\r\n')

    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76)
    expect(lines.join('')).toBe('A'.repeat(500))
  })

  it('uses a plain-text first part when there is no html', () => {
    const raw = buildRfc822({ ...BASE, attachments: [PDF] }, fixedBoundaries('MIX'))

    const parts = partsOf(raw, 'MIX')
    expect(headersOf(raw)['content-type']).toBe('multipart/mixed; boundary="MIX"')
    expect(parts[0]).toMatch(/^Content-Type: text\/plain; charset="UTF-8"/)
  })

  it('picks a mixed boundary that does not occur in the attachment data', () => {
    const raw = buildRfc822(
      { ...MAIL, attachments: [{ ...PDF, data: 'COLLIDE' }] },
      fixedBoundaries('ALT', 'COLLIDE', 'SAFE'),
    )

    expect(headersOf(raw)['content-type']).toBe('multipart/mixed; boundary="SAFE"')
  })

  it('rejects a newline smuggled through a filename', () => {
    // The same hole as a subject, reached through a different door — and this
    // one arrives from a forwarded message's headers, not from the user.
    expect(() =>
      buildRfc822({ ...MAIL, attachments: [{ ...PDF, filename: 'a"\r\nBcc: eve@evil.example' }] }),
    ).toThrow(/newline/i)
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
