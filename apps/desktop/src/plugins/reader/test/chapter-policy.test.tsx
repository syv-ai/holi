/** A `.test.tsx` so it runs in the jsdom project: the policy is put in with a real parser. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/plugin-api', () => ({ openExternal: vi.fn() }))
const { inertFrameDocument, withInertPolicy } = await import('../renderer/inert-frame')

/** The policy, as the frame document spells it: the one constant, read back. */
const INERT_CSP = /content="([^"]*)"/.exec(inertFrameDocument({ background: 'white' }))?.[1]

const XHTML = 'application/xhtml+xml'

/** The first thing in the head a browser reads a policy from. A selector
 *  would also find a `head` in another namespace, which holds none. */
function firstInHead(markup: string, type: DOMParserSupportedType) {
  return new DOMParser().parseFromString(markup, type).head?.firstElementChild
}

describe('a chapter’s policy', () => {
  it('goes first in the head, before the book’s own styles and links', () => {
    const chapter = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="https://x.example/a.css"/><title>1</title></head><body><p>Hi</p></body></html>`
    const first = firstInHead(withInertPolicy(chapter, XHTML), XHTML)
    expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(first?.getAttribute('content')).toBe(INERT_CSP)
  })

  it('is not fooled by a head inside a comment', () => {
    const chapter = `<html xmlns="http://www.w3.org/1999/xhtml"><!-- <head> --><head></head><body/></html>`
    const out = withInertPolicy(chapter, XHTML)
    expect(firstInHead(out, XHTML)?.getAttribute('content')).toBe(INERT_CSP)
  })

  it('gives a chapter with no head one', () => {
    const out = withInertPolicy(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>x</p></body></html>',
      XHTML,
    )
    expect(firstInHead(out, XHTML)?.getAttribute('content')).toBe(INERT_CSP)
    expect(out).toContain('<p>x</p>')
  })

  it('is not fooled by a head in another namespace', () => {
    const chapter = `<html xmlns="http://www.w3.org/1999/xhtml"><head xmlns="urn:foreign"/><body><img src="https://x.example/a.png"/></body></html>`
    const out = withInertPolicy(chapter, XHTML)
    expect(firstInHead(out, XHTML)?.getAttribute('content')).toBe(INERT_CSP)
  })

  it('drops a stylesheet instruction before the root, fetched before any policy', () => {
    const chapter = `<?xml version="1.0"?><?xml-stylesheet type="text/css" href="https://x.example/s.css"?><html xmlns="http://www.w3.org/1999/xhtml"><head/><body/></html>`
    const out = withInertPolicy(chapter, XHTML)
    expect(out).not.toContain('x.example')
    expect(firstInHead(out, XHTML)?.getAttribute('content')).toBe(INERT_CSP)
  })

  it('moves a head written after the body to the front', () => {
    const chapter = `<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="https://x.example/a.png"/></body><head/></html>`
    const doc = new DOMParser().parseFromString(withInertPolicy(chapter, XHTML), XHTML)
    expect(doc.documentElement.firstElementChild).toBe(doc.head)
    expect(doc.head?.firstElementChild?.getAttribute('content')).toBe(INERT_CSP)
  })

  it('blanks a chapter whose root is not HTML, where the policy would be ignored', () => {
    for (const root of [
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://x/a"/></svg>',
      '<x xmlns="urn:x"><y/></x>',
      '<body xmlns="http://www.w3.org/1999/xhtml"><img src="http://x/a"/></body>',
    ]) {
      const out = withInertPolicy(root, 'application/xhtml+xml')
      const doc = new DOMParser().parseFromString(out, 'application/xhtml+xml')
      expect(doc.documentElement.localName).toBe('html')
      expect(doc.head?.firstElementChild?.getAttribute('http-equiv')).toBe(
        'Content-Security-Policy',
      )
      expect(out).not.toContain('http://x/a')
    }
  })

  it('handles an HTML chapter too', () => {
    const out = withInertPolicy('<p>loose</p>', 'text/html')
    expect(firstInHead(out, 'text/html')?.getAttribute('content')).toBe(INERT_CSP)
    expect(out.startsWith('<!doctype html>')).toBe(true)
  })
})
