/**
 * What the terminal's path links answer today, input by input, so a shared
 * rule can replace their prefix logic without changing a result. These record
 * behaviour, including answers that look wrong (a spaced name inside the clone
 * is not linked; a case-variant file URL is revealed, not opened).
 */
import { describe, expect, it } from 'vitest'
import { activateTerminalLink } from '../renderer/lib/terminal-link-activation'
import { vaultLinks } from '../renderer/lib/terminal-links'

const WIN = String.raw`C:\Users\ada\Holi\r`
const POSIX = '/home/ada/Holi/r'
const FILES = new Set(['a.md', 'A.md', 'my notes/a b.md', 'a.md backup.txt'])
const has = (path: string): boolean => FILES.has(path)

describe('vaultLinks in a Windows clone', () => {
  const links = (line: string) => vaultLinks(line, has, WIN)

  it('links a relative, a backslash, a case-variant and a Git Bash spelling', () => {
    expect(links('see ./a.md now')).toEqual([{ path: 'a.md', start: 4, end: 10 }])
    expect(links(`see ${WIN}\\a.md now`)).toEqual([{ path: 'a.md', start: 4, end: 28 }])
    expect(links(String.raw`see c:\users\ada\holi\r\A.md`)).toEqual([
      { path: 'A.md', start: 4, end: 28 },
    ])
    expect(links('see /c/Users/ada/Holi/r/a.md')).toEqual([{ path: 'a.md', start: 4, end: 28 }])
  })

  it('links nothing for a doubled slash or another folder, and a spaced name in the clone whole', () => {
    expect(links('see C:/Users/ada/Holi/r//a.md')).toEqual([])
    expect(links(String.raw`see C:\Users\ada\Other\a.md`)).toEqual([])
    expect(links(`see ${WIN}\\my notes\\a b.md`)).toEqual([
      { path: 'my notes/a b.md', start: 4, end: 39 },
    ])
  })

  it('takes the longest name the vault has past a space, and drops a :line', () => {
    expect(links(`see ${WIN}\\a.md backup.txt`)).toEqual([
      { path: 'a.md backup.txt', start: 4, end: 39 },
    ])
    expect(links(`see ${WIN}\\a.md:12`)).toEqual([{ path: 'a.md', start: 4, end: 28 }])
  })
})

describe('vaultLinks in a POSIX clone', () => {
  const links = (line: string) => vaultLinks(line, has, POSIX)

  it('links ./ and an absolute path, and nothing for a case-variant clone or a spaced name', () => {
    expect(links('see ./a.md now')).toEqual([{ path: 'a.md', start: 4, end: 10 }])
    expect(links(`see ${POSIX}/a.md now`)).toEqual([{ path: 'a.md', start: 4, end: 25 }])
    expect(links('see /home/ada/holi/r/a.md')).toEqual([])
    expect(links(`see ${POSIX}/my notes/a b.md`)).toEqual([])
    expect(links('see my notes/a b.md')).toEqual([])
  })
})

describe('activateTerminalLink for a file URL', () => {
  const run = (url: string, root: string): string[] => {
    const seen: string[] = []
    activateTerminalLink(url, {
      paths: new Set(['a.md', 'my notes/a b.md']),
      root,
      openDocument: (path) => seen.push(`open:${path}`),
      openExternal: () => {},
      revealLocalFile: (path) => seen.push(`reveal:${path}`),
    })
    return seen
  }

  it.each([
    ['file:///C:/Users/ada/Holi/r/a.md', ['open:a.md']],
    // A case-variant spelling of a file the vault has opens it (changed from reveal, by decision).
    ['file:///c:/users/ada/holi/r/a.md', ['open:a.md']],
    ['file:///C:/Users/ada/Holi/r/my%20notes/a%20b.md', ['open:my notes/a b.md']],
    // Another case of a file the vault has opens it, in the vault's spelling.
    ['file:///C:/Users/ada/Holi/r/A.md', ['open:a.md']],
    // In the clone but not a file the vault has: neither opened nor revealed.
    ['file:///C:/Users/ada/Holi/r/nope.md', []],
    ['file:///C:/Users/ada/Other/a.md', ['reveal:C:/Users/ada/Other/a.md']],
    ['file:///C:/Users/ada/Holi/r', ['reveal:C:/Users/ada/Holi/r']],
  ])('win %s', (url, expected) => {
    expect(run(url, WIN)).toEqual(expected)
  })

  it.each([
    ['file:///home/ada/Holi/r/a.md', ['open:a.md']],
    ['file:///home/ada/holi/r/a.md', ['reveal:/home/ada/holi/r/a.md']],
    ['file:///home/ada/Holi/r/my%20notes/a%20b.md', ['open:my notes/a b.md']],
    ['file:///home/ada/Other/a.md', ['reveal:/home/ada/Other/a.md']],
  ])('posix %s', (url, expected) => {
    expect(run(url, POSIX)).toEqual(expected)
  })
})
