/**
 * The " copy" naming rule, shared by Duplicate (inside the vault) and the
 * export (outside it). It lives here rather than in the renderer because main
 * needs it too, and the two must agree: a file duplicated in the tree and the
 * same file exported to a folder that already has one should land on the same
 * name.
 */
import { describe, expect, it } from 'vitest'
import { freeCopyPath } from '../src/copy-names'

describe('freeCopyPath', () => {
  it('returns the path untouched when nothing is in the way', () => {
    expect(freeCopyPath(() => false, 'notes/a.md')).toBe('notes/a.md')
  })

  it('suffixes before the extension, so the file keeps its type', () => {
    const taken = (p: string) => p === 'notes/a.md'
    expect(freeCopyPath(taken, 'notes/a.md')).toBe('notes/a copy.md')
  })

  it('counts up when the copy is taken too', () => {
    const taken = (p: string) => ['notes/a.md', 'notes/a copy.md'].includes(p)
    expect(freeCopyPath(taken, 'notes/a.md')).toBe('notes/a copy 2.md')
  })

  it('suffixes a folder on the bare name — a folder has no extension', () => {
    const taken = (p: string) => p === 'archive'
    expect(freeCopyPath(taken, 'archive')).toBe('archive copy')
  })

  it('treats a dotfile as a name, not an extension', () => {
    // `.gitignore` is entirely a name: the dot is at index 0, and `dot > 0`
    // is what keeps it from becoming ' copy.gitignore'.
    const taken = (p: string) => p === '.gitignore'
    expect(freeCopyPath(taken, '.gitignore')).toBe('.gitignore copy')
  })
})
