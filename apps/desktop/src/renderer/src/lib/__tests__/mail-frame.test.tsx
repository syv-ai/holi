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
