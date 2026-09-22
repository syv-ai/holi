import { THEME_TOKENS } from '@holi/shared'
import { describe, expect, it } from 'vitest'
import {
  PDF_DISABLED_CATEGORIES,
  PDF_PAGE_PLACEHOLDER_CSS,
  pdfViewerTheme,
  shortcutOf,
} from '../src/renderer/src/lib/pdf-viewer-config'

describe('PDF_DISABLED_CATEGORIES', () => {
  it('removes every viewer command whose shortcut Holi or the OS already owns', () => {
    // ⌘O opens a file picker, ⌘P is the palette, ⌘W is the menu accelerator,
    // ⌘⇧S is the screenshot the mail view's save would collide with.
    expect(PDF_DISABLED_CATEGORIES).toEqual(
      expect.arrayContaining(['document-open', 'document-print', 'document-close', 'capture']),
    )
  })

  it('keeps reading, searching and marking', () => {
    for (const kept of ['zoom', 'search', 'selection', 'annotation', 'history', 'scroll', 'pan']) {
      expect(PDF_DISABLED_CATEGORIES).not.toContain(kept)
    }
  })
})

describe('pdfViewerTheme', () => {
  const walk = (node: unknown, out: string[] = []): string[] => {
    if (typeof node === 'string') out.push(node)
    else if (node && typeof node === 'object') Object.values(node).forEach((v) => walk(v, out))
    return out
  }

  it('speaks only in Holi tokens, never a colour literal', () => {
    const theme = pdfViewerTheme('dark')
    const values = [...walk(theme.light), ...walk(theme.dark)]
    expect(values.length).toBeGreaterThan(10)
    for (const value of values) {
      const m = /^var\(--([a-z-]+)\)$/.exec(value)
      expect(m, value).not.toBeNull()
      expect(THEME_TOKENS, value).toContain(m![1])
    }
  })

  it('carries the mode as the preference and the same map for both modes', () => {
    expect(pdfViewerTheme('light').preference).toBe('light')
    expect(pdfViewerTheme('dark').preference).toBe('dark')
    // The variables already flip with the mode; the map does not have to.
    expect(pdfViewerTheme('dark').light).toEqual(pdfViewerTheme('dark').dark)
  })
})

describe('PDF_PAGE_PLACEHOLDER_CSS', () => {
  it("overrides the viewer's hard-coded white page with a Holi token", () => {
    // embedpdf paints every page wrapper `#fff` inline until PDFium's bitmap
    // lands; on a dark PDF that is the white flash. The bitmap brings its own
    // paper, so the wrapper is only ever a placeholder.
    expect(PDF_PAGE_PLACEHOLDER_CSS).toContain('[style*="background-color: rgb(255, 255, 255)"]')
    const values = [
      ...PDF_PAGE_PLACEHOLDER_CSS.matchAll(/\{\s*background-color:\s*([^;!]+?)\s*!important/g),
    ]
    expect(values).toHaveLength(1)
    const m = /^var\(--([a-z-]+)\)$/.exec(values[0]![1]!)
    expect(m, values[0]![1]).not.toBeNull()
    expect(THEME_TOKENS).toContain(m![1])
  })
})

describe('shortcutOf', () => {
  const ev = (init: Partial<KeyboardEvent>) => init as KeyboardEvent

  it("normalises the way the viewer's commands plugin does", () => {
    expect(shortcutOf(ev({ key: 'P', metaKey: true }))).toBe('meta+p')
    expect(shortcutOf(ev({ key: 'h' }))).toBe('h')
    expect(shortcutOf(ev({ key: 'Z', ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+z')
    expect(shortcutOf(ev({ key: 'ArrowLeft' }))).toBe('arrowleft')
    expect(shortcutOf(ev({ key: ' ' }))).toBe('space')
  })

  it('is null for a bare modifier', () => {
    expect(shortcutOf(ev({ key: 'Shift', shiftKey: true }))).toBeNull()
    expect(shortcutOf(ev({ key: 'Meta', metaKey: true }))).toBeNull()
  })
})
