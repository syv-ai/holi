/** A `.test.tsx` so it runs in the jsdom project: pages are built with a real parser. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/plugin-api', () => ({ openExternal: vi.fn() }))
const { chapterType, closeBook, guardChapters, imagePage } =
  await import('../renderer/epub-chapters')

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

  it('stay matched to their sections when the spine names a missing page', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:guarded')
    const manifest = [
      { id: 'svg', mediaType: 'image/svg+xml' },
      { id: 'chapter', mediaType: 'application/xhtml+xml' },
    ]
    const section = (src: string) => ({ load: async () => src, unload: () => {} })
    const sections = [section('blob:svg'), section('blob:chapter')]
    const book = {
      resources: {
        manifest,
        spine: [{ idref: 'ghost' }, { idref: 'svg' }, { idref: 'chapter' }],
        getItemByID: (id: string) => manifest.find((item) => item.id === id),
      },
      sections,
    }

    guardChapters(book as never)

    expect(await sections[0]!.load()).toBe('blob:guarded')
    expect(await sections[1]!.load()).toBe('blob:chapter')
  })

  it('are let go of even when foliate cannot close a book that never drew', () => {
    const remove = vi.fn()
    const destroy = vi.fn()
    const view = {
      close: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'destroy')")
      },
      remove,
    }

    expect(() => closeBook(view as never, { destroy } as never)).not.toThrow()

    expect(remove).toHaveBeenCalled()
    expect(destroy).toHaveBeenCalled()
  })
})
