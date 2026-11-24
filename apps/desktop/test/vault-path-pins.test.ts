/**
 * What the main-side copies of "which vault path does this OS path name" answer
 * today, input by input, so a shared rule can replace them without changing a
 * result. These record behaviour, including answers that look wrong (a doubled
 * slash, a case-variant remainder on POSIX): changing one is a decision, not a
 * test fix.
 */
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseListing } from '../src/plugins/agent/main/claude/listing'
import { pathUnderRoot, toVaultRel, typedVaultPath } from '../src/main/vault/vault-files'

const WIN = String.raw`C:\Users\ada\Holi\r`
const POSIX = '/home/ada/Holi/r'

describe('pathUnderRoot and typedVaultPath on win32', () => {
  const rows: [string, string, string][] = [
    // [typed, pathUnderRoot, typedVaultPath]
    ['./a.md', './a.md', 'a.md'],
    [WIN, 'C:/Users/ada/Holi/r', ''],
    [`${WIN}\\`, '', ''],
    [`${WIN}/`, '', ''],
    ['C:/Users/ada/Holi/r//a.md', '/a.md', 'a.md'],
    ['C:/Users/ada/Holi/r/a.md', 'a.md', 'a.md'],
    [String.raw`C:\Users\ada\Holi\r\a.md`, 'a.md', 'a.md'],
    [String.raw`c:\users\ada\holi\r\A.md`, 'A.md', 'A.md'],
    [String.raw`C:\Users\ada\Other\a.md`, 'C:/Users/ada/Other/a.md', '../../Other/a.md'],
    ['/c/Users/ada/Holi/r/a.md', 'a.md', 'a.md'],
    [String.raw`C:\Users\ada\Holi\r\my notes\a b.md`, 'my notes/a b.md', 'my notes/a b.md'],
  ]
  it.each(rows)('%s', (typed, under, vault) => {
    expect(pathUnderRoot(WIN, typed, 'win32')).toBe(under)
    expect(typedVaultPath(WIN, typed, 'win32')).toBe(vault)
  })
})

describe('pathUnderRoot and typedVaultPath on linux', () => {
  const rows: [string, string, string][] = [
    ['./a.md', './a.md', 'a.md'],
    [POSIX, POSIX, ''],
    [`${POSIX}/`, '', ''],
    [`${POSIX}//a.md`, '/a.md', 'a.md'],
    [`${POSIX}/a.md`, 'a.md', 'a.md'],
    ['/home/ada/Other/a.md', '/home/ada/Other/a.md', '../../Other/a.md'],
    // A case-variant root is another folder on POSIX.
    ['/home/ada/holi/r/a.md', '/home/ada/holi/r/a.md', '../../holi/r/a.md'],
    [`${POSIX}/My Notes/a b.md`, 'My Notes/a b.md', 'My Notes/a b.md'],
    // `/c/` is a plain absolute path here, not a drive.
    ['/c/home/ada/Holi/r/a.md', '/c/home/ada/Holi/r/a.md', '../../../../c/home/ada/Holi/r/a.md'],
  ]
  it.each(rows)('%s', (typed, under, vault) => {
    expect(pathUnderRoot(POSIX, typed, 'linux')).toBe(under)
    expect(typedVaultPath(POSIX, typed, 'linux')).toBe(vault)
  })
})

describe('toVaultRel, on the OS running the tests', () => {
  // `vaultPathOf` in the PDF plugin is this function's body, kept private there.
  const root = resolve('vault-root')

  it('names a file inside, spaces and all', () => {
    expect(toVaultRel(root, join(root, 'a.md'))).toBe('a.md')
    expect(toVaultRel(root, join(root, 'my notes', 'a b.md'))).toBe('my notes/a b.md')
  })

  it('names nothing for the root itself or for a path outside', () => {
    expect(toVaultRel(root, root)).toBeNull()
    expect(toVaultRel(root, join(root, '..', 'other', 'a.md'))).toBeNull()
  })

  it('reads a root written with a trailing separator', () => {
    expect(toVaultRel(`${root}${join('/', '')}`, join(root, 'a.md'))).toBe('a.md')
  })

  it('reads a doubled separator as the same file', () => {
    expect(toVaultRel(root, `${root}${join('/', '')}${join('/', '')}a.md`)).toBe('a.md')
  })

  it('folds case only where the OS does', () => {
    const variant = join(root.toUpperCase(), 'a.md')
    expect(toVaultRel(root, variant)).toBe(process.platform === 'win32' ? 'a.md' : null)
  })
})

describe('which sessions are under the vault (isUnder, through parseListing)', () => {
  const under = (cwd: string, root: string): number =>
    parseListing(JSON.stringify([{ kind: 'background', id: 'abcdef01', cwd }]), root).length

  it.each([
    [WIN, 1],
    [`${WIN}\\`, 1],
    [`${WIN}\\sub`, 1],
    [WIN.toLowerCase(), 1],
    ['C:/Users/ada/Holi/r', 1],
    [`${WIN}x`, 0],
    [String.raw`C:\Users\ada\Other`, 0],
  ])('win32 %s', (cwd, count) => {
    expect(under(cwd, WIN)).toBe(count)
  })

  it.each([
    [POSIX, 1],
    [`${POSIX}/`, 1],
    [`${POSIX}/sub`, 1],
    [POSIX.toLowerCase(), 0],
    [`${POSIX}x`, 0],
    ['/home/ada/Other', 0],
  ])('linux %s', (cwd, count) => {
    expect(under(cwd, POSIX)).toBe(count)
  })
})
