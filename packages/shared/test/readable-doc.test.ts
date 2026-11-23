import { describe, expect, it } from 'vitest'
import { readableDoc } from '../src/file-kind'

describe('readableDoc', () => {
  it('takes docx, pptx and epub, whatever the case of the extension', () => {
    expect(readableDoc('a/report.docx')).toBe('docx')
    expect(readableDoc('Deck.PPTX')).toBe('pptx')
    expect(readableDoc('books/novel.Epub')).toBe('epub')
  })
  it('leaves every other name alone', () => {
    for (const path of [
      'a.doc',
      'a.ppt',
      'a.xlsx',
      'a.docx.md',
      'docx',
      '.epub',
      'dir.docx/notes.md',
    ])
      expect(readableDoc(path)).toBeNull()
  })
})
