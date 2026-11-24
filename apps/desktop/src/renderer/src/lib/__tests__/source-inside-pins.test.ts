/**
 * What `sourceInside` answers today for a dropped path, input by input, so a
 * shared rule can replace it without changing a result. These record behaviour,
 * including answers that look wrong (the doubled slash, and a case-variant
 * remainder returned in the source's own spelling).
 */
import { describe, expect, it } from 'vitest'
import { sourceInside } from '../tree-paths'

const WIN = String.raw`C:\Users\ada\Holi\r`
const POSIX = '/home/ada/Holi/r'

describe('sourceInside, a Windows source', () => {
  it.each([
    [WIN, String.raw`C:\Users\ada\Holi\r\a.md`, 'a.md'],
    [WIN, WIN, null],
    [`${WIN}\\`, String.raw`C:\Users\ada\Holi\r\a.md`, 'a.md'],
    [WIN, 'C:/Users/ada/Holi/r//a.md', '/a.md'],
    // The remainder keeps the source's spelling, not the vault's.
    [WIN, String.raw`c:\users\ada\holi\r\A.md`, 'A.md'],
    [WIN, String.raw`C:\Users\ada\Other\a.md`, null],
    [WIN, String.raw`C:\Users\ada\Holi\r\my notes\a b.md`, 'my notes/a b.md'],
    [WIN, '/c/Users/ada/Holi/r/a.md', null],
  ])('%s, %s', (root, source, expected) => {
    expect(sourceInside(root, source)).toBe(expected)
  })
})

describe('sourceInside, a POSIX source', () => {
  it.each([
    [POSIX, `${POSIX}/a.md`, 'a.md'],
    [POSIX, POSIX, null],
    [`${POSIX}/`, `${POSIX}/a.md`, 'a.md'],
    [POSIX, `${POSIX}//a.md`, '/a.md'],
    [POSIX, '/home/ada/holi/r/a.md', null],
    [POSIX, '/home/ada/Other/a.md', null],
    [POSIX, `${POSIX}/my notes/a b.md`, 'my notes/a b.md'],
  ])('%s, %s', (root, source, expected) => {
    expect(sourceInside(root, source)).toBe(expected)
  })
})
