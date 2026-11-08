/** A `.test.tsx` so it runs in the jsdom project: pages are built with a real parser. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/plugin-api', () => ({ openExternal: vi.fn() }))
const { chapterType, imagePage } = await import('../renderer/epub-chapters')

describe('a book’s pages', () => {
  it('are parsed as markup however the book spells the type', () => {
    expect(chapterType('application/xhtml+xml')).toBe('application/xhtml+xml')
    expect(chapterType('Application/XHTML+XML')).toBe('application/xhtml+xml')
    expect(chapterType('application/xhtml+xml; charset=utf-8')).toBe('application/xhtml+xml')
    expect(chapterType('application/xml')).toBe('application/xhtml+xml')
    expect(chapterType('text/xml')).toBe('application/xhtml+xml')
    expect(chapterType(' TEXT/HTML ')).toBe('text/html')
  })

  it('that are not markup are not chapters', () => {
    for (const type of ['image/svg+xml', 'image/png', 'text/css', 'application/javascript', ''])
      expect(chapterType(type)).toBeNull()
  })

  it('that are images are shown in a page with the policy first', () => {
    const page = imagePage('blob:http://x/1"><script>bad()</script>')
    const doc = new DOMParser().parseFromString(page, 'application/xhtml+xml')
    expect(doc.querySelector('head')?.firstElementChild?.getAttribute('http-equiv')).toBe(
      'Content-Security-Policy',
    )
    expect(doc.querySelectorAll('img')).toHaveLength(1)
    expect(doc.querySelector('script')).toBeNull()
  })
})
