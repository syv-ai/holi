/**
 * The frame document, the containment half of mail rendering: its strict CSP,
 * the theme reaching a document the app's cascade cannot, and the message's own
 * styling winning inside its page. What markup survives is `mail-html.test.tsx`.
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
} from '../renderer/mail-frame'
import { sanitizeMailHtml } from '../renderer/mail-html'

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
    // `@import` is a fetch no attribute pass can see; `default-src 'none'`
    // kills it.
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

describe('mailFrameDocument — the message’s own stylesheet', () => {
  /**
   * The sheet arrives as text and never passes DOMPurify's HTML parser, so
   * `<style>` stays a forbidden tag and the message keeps its design.
   */
  it('carries the message stylesheet, after its own defaults so the message wins', () => {
    const html = doc({ css: '@media (min-width:480px){.col{width:65%}}' })

    expect(html).toContain('@media (min-width:480px){.col{width:65%}}')
    expect(html.indexOf('color-scheme')).toBeLessThan(html.indexOf('.col{width:65%}'))
  })

  it('adds no empty stylesheet for a message that brought none', () => {
    // Two <style> elements are the floor (defaults, invariants); no empty third.
    expect(doc().match(/<style>/g)).toHaveLength(2)
  })

  /**
   * The two modules composed as `SandboxedHtml` does, because the bug both unit
   * suites would miss is the seam: a sheet lifted but not passed on.
   */
  it('carries an MJML column layout all the way from raw markup into the document', () => {
    const raw =
      '<style>@media only screen and (min-width:480px){' +
      '.mj-column-per-65{width:65%!important}.mj-column-per-35{width:35%!important}}</style>' +
      '<div class="mj-column-per-65" style="display:inline-block;width:100%">left</div>' +
      '<div class="mj-column-per-35" style="display:inline-block;width:100%">right</div>'
    const sanitized = sanitizeMailHtml(raw)

    const html = doc({ html: sanitized.html, css: sanitized.css })
    const parsed = new DOMParser().parseFromString(html, 'text/html')

    // The rule that decides whether the two divs sit side by side or stack.
    expect(html).toContain('.mj-column-per-65{width:65%!important}')
    expect(html).toContain('min-width:480px')
    // And it is in a stylesheet, not loose in the body.
    expect(parsed.body.querySelector('style')).toBeNull()
    expect(parsed.body.querySelectorAll('div')).toHaveLength(2)
  })

  /**
   * A stylesheet is interpolated by hand, like the palette values, so `</` is
   * stripped: the only way out of the element.
   */
  it('neutralises a stylesheet that tries to close its own element', () => {
    const html = doc({ css: '}</style><img src=x onerror=alert(1)><style>' })
    const parsed = new DOMParser().parseFromString(html, 'text/html')

    // The payload survives as inert text; what matters is that no <img>
    // element exists.
    expect(parsed.querySelector('img')).toBeNull()
    expect(parsed.querySelectorAll('style')).toHaveLength(3)
    const sheets = [...parsed.querySelectorAll('style')]
    expect(sheets.some((sheet) => sheet.textContent?.includes('onerror'))).toBe(true)
  })

  /**
   * The app sizes the frame, so a message must not turn scrolling back on.
   * Aesthetics go before the message; this goes after it.
   */
  it('keeps the no-scroll rule after the message, which cannot override it', () => {
    const html = doc({ css: 'html{overflow-y:scroll}body{overflow:visible}' })

    expect(html.lastIndexOf('overflow-y: hidden')).toBeGreaterThan(
      html.indexOf('html{overflow-y:scroll}'),
    )
  })
})

describe('readMailPalette', () => {
  it('falls back to a readable page when the tokens are not resolvable', () => {
    // jsdom loads no stylesheet, so every token reads empty; `background: ;`
    // would render a transparent frame.
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

    // A vault switch writes properties onto the root without React state, so
    // this is observed.
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

    // Identity matters: the palette is a frame effect dependency.
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
 * Which canvas a block of HTML renders on. Mail declares its ink and assumes
 * white paper, so any sign of design means paper: a wrong white block is
 * ordinary, a wrong dark canvas is unreadable.
 */
describe('canvasFor', () => {
  const paper = { background: '#ffffff', scheme: 'light' }

  it('gives the app’s theme to prose that brought no design', () => {
    expect(canvasFor('<p>hello, here is the plan</p>', PALETTE)).toBe(PALETTE)
  })

  it('gives paper to a message that sets a text colour', () => {
    // Ink declared, paper assumed.
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
    // Images were drawn to sit on white.
    expect(bringsOwnDesign('<img src="https://cdn.test/logo.png">')).toBe(true)
  })

  it('does not change its mind when the images are unblocked', () => {
    // Read from the raw html, so "Load images" cannot flip the canvas.
    const html = '<p style="color:#222">hi</p><img src="https://cdn.test/logo.png">'
    const blocked = '<p style="color:#222">hi</p><img>'

    expect(bringsOwnDesign(html)).toBe(bringsOwnDesign(blocked))
  })

  it('sets color-scheme to light with the paper, so the frame’s own defaults follow', () => {
    // Or scrollbars and controls stay dark on a white page.
    const html = mailFrameDocument({
      html: '<p>x</p>',
      palette: canvasFor('<p style="color:#333">x</p>', PALETTE),
      allowRemoteContent: false,
    })

    expect(html).toContain('color-scheme: light')
  })
})
