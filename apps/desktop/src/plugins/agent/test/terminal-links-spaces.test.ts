import { describe, expect, it } from 'vitest'
import { vaultLinks } from '../renderer/lib/terminal-links'

const WIN = String.raw`C:\Users\ada\Holi\r`
const known = new Set(['a.md', 'a.md backup.txt', 'my notes/a b.md', 'x y.md'])
const links = (line: string) => vaultLinks(line, (path) => known.has(path), WIN)

describe('a file name with spaces in a Windows clone', () => {
  it('links the longest name that exists, not a shorter one it starts with', () => {
    expect(links(`ran ${WIN}\\a.md backup.txt done`).map((l) => l.path)).toEqual([
      'a.md backup.txt',
    ])
    expect(links(`ran ${WIN}\\a.md and more`).map((l) => l.path)).toEqual(['a.md'])
  })

  it('links a quoted spaced name, up to the quote', () => {
    const line = `open "${WIN}\\my notes\\a b.md" now`
    expect(links(line)).toEqual([{ path: 'my notes/a b.md', start: 6, end: 6 + WIN.length + 16 }])
  })

  it('takes a name before a :line and before punctuation', () => {
    expect(links(`${WIN}\\x y.md:12`).map((l) => l.path)).toEqual(['x y.md'])
    expect(links(`(${WIN}\\x y.md),`).map((l) => l.path)).toEqual(['x y.md'])
  })

  it('links nothing for a spaced folder outside the clone', () => {
    expect(links(String.raw`see C:\Users\ada\My Docs\x y.md`)).toEqual([])
  })

  it('links a name in a clone whose own path has a space, before a full stop or a backtick', () => {
    const spaced = String.raw`C:\Users\Ada Lovelace\Holi\syv\vault`
    const has = (path: string) => path === 'docs/guide.md'
    expect(vaultLinks(`Read ${spaced}\\docs\\guide.md.`, has, spaced).map((l) => l.path)).toEqual([
      'docs/guide.md',
    ])
    expect(
      vaultLinks(`Read \`${spaced}\\docs\\guide.md\``, has, spaced).map((l) => l.path),
    ).toEqual(['docs/guide.md'])
  })

  it('tries a bounded number of spaces on a long line', () => {
    expect(links(`${WIN}\\${'w '.repeat(500)}zz.md`)).toEqual([])
  })
})
