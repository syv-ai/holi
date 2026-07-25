import { describe, expect, it } from 'vitest'
import { fileKind } from '../src/file-kind'

describe('fileKind', () => {
  it('classifies markdown', () => {
    expect(fileKind('a.md')).toBe('markdown')
    expect(fileKind('notes/deep/b.md')).toBe('markdown')
  })
  it('classifies editable text (incl. unknown/no extension — the forgiving default)', () => {
    for (const p of ['a.json', 'a.txt', 'a.csv', 'a.yaml', 'a.yml', 'a.env', 'a.ts', '.gitignore', 'Makefile'])
      expect(fileKind(p)).toBe('text')
  })
  it('classifies known rich types that need a renderer', () => {
    for (const p of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.svg']) expect(fileKind(p)).toBe('image')
    expect(fileKind('a.pdf')).toBe('pdf')
    for (const p of ['a.docx', 'a.doc', 'a.xlsx', 'a.pptx']) expect(fileKind(p)).toBe('doc')
  })
})
