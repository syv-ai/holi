/**
 * The frame document — the containment half of mail rendering.
 *
 * `mail-html.test.tsx` covers what markup survives; this covers the page that
 * markup lands on: that the frame carries its own strict CSP, that the theme
 * actually reaches a document the app's cascade cannot, and that a message's
 * own styling still wins inside its own page.
 */
import { renderHook, act } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bringsOwnDesign,
  canvasFor,
  mailFrameDocument,
  openableLink,
  readMailPalette,
  useMailPalette,
  type MailPalette,
} from '../mail-frame'

const PALETTE: MailPalette = {
  background: '#101010',
  foreground: '#eeeeee',
  muted: '#888888',
  border: '#333333',
  link: '#66aaff',
  scheme: 'dark',
}

const doc = (options: Partial<Parameters<typeof mailFrameDocument>[0]> = {}) =>
  mailFrameDocument({ html: '<p>hi</p>', palette: PALETTE, allowRemoteContent: false, ...options })

/** The `content` of the document's CSP meta, parsed out of the markup. */
function cspOf(html: string): string {
  return /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? ''
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
  for (const token of ['--card', '--card-foreground', '--primary']) {
    document.documentElement.style.removeProperty(token)
  }
})

describe('mailFrameDocument — the frame’s own policy', () => {
  it('denies everything by default, so a route the sanitizer missed is still dead', () => {
    // The point of a second layer: `@import` inside a stylesheet is a remote
    // fetch no attribute pass can see, and `default-src 'none'` kills it.
    expect(cspOf(doc())).toContain("default-src 'none'")
  })

  it('permits only inline styles and data: images while remote content is blocked', () => {
    const csp = cspOf(doc({ allowRemoteContent: false }))

    expect(csp).toContain('img-src data:')
    expect(csp).not.toContain('https:')
    expect(csp).toContain("style-src 'unsafe-inline'")
  })

  it('widens img-src only when the user has loaded images', () => {
    const csp = cspOf(doc({ allowRemoteContent: true }))

    expect(csp).toContain('img-src data: https: http:')
    // Loading images is never permission to run anything.
    expect(csp).toContain("default-src 'none'")
  })

  it('carries the sanitized body verbatim', () => {
    expect(doc({ html: '<p>the <b>message</b></p>' })).toContain('<p>the <b>message</b></p>')
  })
})

describe('mailFrameDocument — theming', () => {
  it('writes the palette in as real values, since no cascade reaches the frame', () => {
    const html = doc()

    expect(html).toContain('background: #101010')
    expect(html).toContain('color: #eeeeee')
    expect(html).toContain('a { color: #66aaff; }')
    expect(html).toContain('color-scheme: dark')
  })

  it('puts its defaults before the message, so the sender’s own styling wins', () => {
    const html = doc({ html: '<style>body{background:#fff}</style><p>hi</p>' })

    expect(html.indexOf('color-scheme')).toBeLessThan(html.indexOf('body{background:#fff}'))
  })
})

describe('readMailPalette', () => {
  it('falls back to a readable page when the tokens are not resolvable', () => {
    // jsdom loads no stylesheet, so every token reads empty — the same shape as
    // a theme that omits a key. `background: ;` would render a transparent frame.
    const palette = readMailPalette()

    expect(palette.background).not.toBe('')
    expect(palette.foreground).not.toBe('')
  })

  it('reads the app tokens when they are set on the root', () => {
    document.documentElement.style.setProperty('--card', '#123456')

    expect(readMailPalette().background).toBe('#123456')
  })

  it('strips anything that could break out of the declaration it lands in', () => {
    document.documentElement.style.setProperty('--card', 'red} body{display:none')

    expect(readMailPalette().background).not.toContain('}')
  })

  it('follows the light/dark mode stamped on the root', () => {
    expect(readMailPalette().scheme).toBe('dark')
    document.documentElement.dataset.theme = 'light'
    expect(readMailPalette().scheme).toBe('light')
  })
})

describe('useMailPalette', () => {
  it('re-reads when the theme rewrites the root, and holds identity when it does not', async () => {
    const { result } = renderHook(() => useMailPalette())
    const first = result.current

    // A vault switch writes custom properties straight onto the root — no React
    // state is involved, which is why this is observed rather than subscribed.
    await act(async () => {
      document.documentElement.style.setProperty('--card', '#abcdef')
      await Promise.resolve()
    })

    expect(result.current.background).toBe('#abcdef')
    expect(result.current).not.toBe(first)

    const second = result.current
    await act(async () => {
      document.documentElement.style.setProperty('--card', '#abcdef')
      await Promise.resolve()
    })

    // Identity matters: the palette is a frame effect dependency, so a fresh
    // object per render would rewrite every open message on every render.
    expect(result.current).toBe(second)
  })
})

describe('openableLink', () => {
  it('accepts the schemes a message may hand to the OS', () => {
    expect(openableLink('https://syv.ai')).toBe('https://syv.ai')
    expect(openableLink('mailto:a@b.c')).toBe('mailto:a@b.c')
  })

  it('refuses everything else, including a missing href', () => {
    expect(openableLink('file:///etc/passwd')).toBeNull()
    expect(openableLink('javascript:alert(1)')).toBeNull()
    expect(openableLink('/relative')).toBeNull()
    expect(openableLink(null)).toBeNull()
  })
})

/**
 * Which canvas a block of HTML renders on.
 *
 * **The bug: a dark theme made real mail unreadable.** A newsletter declares
 * its ink (`color: #333`) and inherits its paper, because for thirty years the
 * client's paper has been white. Rendering that on the app's dark surface is
 * black text on a black background — and the images go with it, since a logo is
 * usually dark ink on transparency and simply disappears.
 *
 * So the rule is asymmetric on purpose: any sign of design at all means paper.
 * Wrongly giving paper costs a white block in a dark app, which is what every
 * other mail client shows. Wrongly giving the theme costs an unreadable message.
 */
describe('canvasFor', () => {
  const paper = { background: '#ffffff', scheme: 'light' }

  it('gives the app’s theme to prose that brought no design', () => {
    expect(canvasFor('<p>hello, here is the plan</p>', PALETTE)).toBe(PALETTE)
  })

  it('gives paper to a message that sets a text colour', () => {
    // The exact shape that was unreadable: ink declared, paper assumed.
    expect(canvasFor('<p style="color:#333333">hello</p>', PALETTE)).toMatchObject(paper)
  })

  it.each([
    ['a background', '<td style="background-color:#f5f5f5">x</td>'],
    ['a bgcolor attribute', '<table bgcolor="#ffffff"><tr><td>x</td></tr></table>'],
    ['a font tag', '<font color="#000000">x</font>'],
    ['an image', '<p>hi</p><img src="https://cdn.test/logo.png">'],
  ])('gives paper to a message carrying %s', (_what, html) => {
    expect(canvasFor(html, PALETTE)).toMatchObject(paper)
  })

  it('counts an image even with no colour anywhere', () => {
    // Not about text at all: those pixels were drawn to sit on white, and a
    // dark-ink logo on a dark canvas reads as "the images did not load".
    expect(bringsOwnDesign('<img src="https://cdn.test/logo.png">')).toBe(true)
  })

  it('does not change its mind when the images are unblocked', () => {
    // Read from the RAW html, so the canvas cannot flip underneath a message as
    // a side effect of pressing "Load images" — the sanitizer strips the `src`
    // while blocking, and a rule reading the sanitized output would see a
    // different document before and after.
    const html = '<p style="color:#222">hi</p><img src="https://cdn.test/logo.png">'
    const blocked = '<p style="color:#222">hi</p><img>'

    expect(bringsOwnDesign(html)).toBe(bringsOwnDesign(blocked))
  })

  it('sets color-scheme to light with the paper, so the frame’s own defaults follow', () => {
    // Scrollbars and any control a message contains would otherwise stay dark
    // on a white page.
    const html = mailFrameDocument({
      html: '<p>x</p>',
      palette: canvasFor('<p style="color:#333">x</p>', PALETTE),
      allowRemoteContent: false,
    })

    expect(html).toContain('color-scheme: light')
  })
})
