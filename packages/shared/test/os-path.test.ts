import { describe, expect, it } from 'vitest'
import { pathBelowRoot, resolveVaultPath, vaultPathIndex } from '../src/os-path'

const WIN = String.raw`C:\Users\ada\Holi\r`
const POSIX = '/home/ada/Holi/r'

describe('pathBelowRoot', () => {
  it('cuts a Windows root off in either separator, either case, and a /c/ drive', () => {
    expect(pathBelowRoot(WIN, String.raw`C:\Users\ada\Holi\r\a.md`, 'win32')).toBe('a.md')
    expect(pathBelowRoot(WIN, 'C:/Users/ada/Holi/r/a.md', 'win32')).toBe('a.md')
    expect(pathBelowRoot(WIN, String.raw`c:\users\ada\holi\r\A.md`, 'win32')).toBe('A.md')
    expect(pathBelowRoot(WIN, '/c/Users/ada/Holi/r/a.md', 'win32')).toBe('a.md')
    expect(
      pathBelowRoot(`${WIN}\\`, String.raw`C:\Users\ada\Holi\r\my notes\a b.md`, 'win32'),
    ).toBe('my notes/a b.md')
  })

  it('is null for the root itself and for another folder', () => {
    expect(pathBelowRoot(WIN, WIN, 'win32')).toBeNull()
    expect(pathBelowRoot(WIN, `${WIN}\\`, 'win32')).toBeNull()
    expect(pathBelowRoot(WIN, String.raw`C:\Users\ada\Holi\rx\a.md`, 'win32')).toBeNull()
    expect(pathBelowRoot(WIN, String.raw`C:\Users\ada\Other\a.md`, 'win32')).toBeNull()
  })

  it('keeps a doubled separator in the remainder, for the caller to refuse', () => {
    expect(pathBelowRoot(WIN, 'C:/Users/ada/Holi/r//a.md', 'win32')).toBe('/a.md')
  })

  it('reads POSIX exactly: case counts, a backslash is a name character, /c/ is a folder', () => {
    expect(pathBelowRoot(POSIX, `${POSIX}/a.md`, 'posix')).toBe('a.md')
    expect(pathBelowRoot(`${POSIX}/`, `${POSIX}/a.md`, 'posix')).toBe('a.md')
    expect(pathBelowRoot(POSIX, POSIX, 'posix')).toBeNull()
    expect(pathBelowRoot(POSIX, '/home/ada/holi/r/a.md', 'posix')).toBeNull()
    expect(pathBelowRoot('/c/Users/ada', '/c/Users/ada/a.md', 'posix')).toBe('a.md')
    expect(pathBelowRoot(POSIX, `${POSIX}/a\\b.md`, 'posix')).toBe('a\\b.md')
  })
})

describe('resolveVaultPath', () => {
  const paths = ['a.md', 'Notes/Plan.md', 'my notes/a b.md', 'Empty']

  it('gives the snapshot spelling of a Windows path whose case differs', () => {
    const index = vaultPathIndex(paths, 'win32')
    expect(
      resolveVaultPath(WIN, String.raw`c:\users\ada\holi\r\notes\plan.MD`, index, 'win32'),
    ).toBe('Notes/Plan.md')
    expect(resolveVaultPath(WIN, String.raw`C:\Users\ada\Holi\r\EMPTY`, index, 'win32')).toBe(
      'Empty',
    )
    expect(resolveVaultPath(WIN, '/c/Users/ada/Holi/r/my notes/a b.md', index, 'win32')).toBe(
      'my notes/a b.md',
    )
  })

  it('is null for what the snapshot lacks, the root, a doubled slash, and another folder', () => {
    const index = vaultPathIndex(paths, 'win32')
    expect(resolveVaultPath(WIN, String.raw`C:\Users\ada\Holi\r\b.md`, index, 'win32')).toBeNull()
    expect(resolveVaultPath(WIN, WIN, index, 'win32')).toBeNull()
    expect(resolveVaultPath(WIN, 'C:/Users/ada/Holi/r//a.md', index, 'win32')).toBeNull()
    expect(resolveVaultPath(WIN, String.raw`C:\Users\ada\Other\a.md`, index, 'win32')).toBeNull()
  })

  it('matches POSIX names exactly', () => {
    const index = vaultPathIndex(paths, 'posix')
    expect(resolveVaultPath(POSIX, `${POSIX}/Notes/Plan.md`, index, 'posix')).toBe('Notes/Plan.md')
    expect(resolveVaultPath(POSIX, `${POSIX}/notes/plan.md`, index, 'posix')).toBeNull()
    expect(resolveVaultPath(POSIX, '/home/ada/holi/r/a.md', index, 'posix')).toBeNull()
  })
})
