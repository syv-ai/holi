/**
 * The " copy" naming rule, shared by Duplicate (inside the vault) and the
 * export (outside it). It lives here rather than in the renderer because main
 * needs it too, and the two must agree: a file duplicated in the tree and the
 * same file exported to a folder that already has one should land on the same
 * name.
 */
import { describe, expect, it } from 'vitest'
import { freeCopyPath } from '../src/copy-names'
import { isLocalOnlyPath } from '../src/path-safety'

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

  /**
   * **Duplicating a personal file must not publish it** (D65).
   *
   * Splitting on the last dot alone produced `x.local copy.md`, where `local`
   * is followed by a space — so the marker stopped matching, `*.local.*`
   * stopped ignoring it, and the copy was committed. Observed in a real vault:
   * a duplicated `memory/x.local.md` was pushed and listed in the shared index.
   */
  it('keeps a duplicate of a machine-local file machine-local', () => {
    const taken = (p: string) => p === 'memory/roles.local.md'
    const copy = freeCopyPath(taken, 'memory/roles.local.md')

    expect(copy).toBe('memory/roles copy.local.md')
    // The assertion that actually matters — the name is a means to this.
    expect(isLocalOnlyPath(copy)).toBe(true)
  })

  it('does the same for the other local files, which have their own extensions', () => {
    for (const [path, expected] of [
      ['USER.local.md', 'USER copy.local.md'],
      ['.holi/settings.local.json', '.holi/settings copy.local.json'],
    ] as const) {
      const copy = freeCopyPath((p) => p === path, path)
      expect(copy).toBe(expected)
      expect(isLocalOnlyPath(copy)).toBe(true)
    }
  })

  it('counts up on a local file without losing the marker', () => {
    const taken = (p: string) =>
      ['a.local.md', 'a copy.local.md'].includes(p)
    const copy = freeCopyPath(taken, 'a.local.md')
    expect(copy).toBe('a copy 2.local.md')
    expect(isLocalOnlyPath(copy)).toBe(true)
  })

  it('only treats a TRAILING .local. as the extension, and stays local anyway', () => {
    // The marker is mid-name here, so this takes the ordinary branch — and the
    // file is STILL machine-local, because `.local.` survives in the middle of
    // the copy's name. The invariant is locality, not where the suffix lands.
    const taken = (p: string) => p === 'notes.local.draft.md'
    const copy = freeCopyPath(taken, 'notes.local.draft.md')

    expect(copy).toBe('notes.local.draft copy.md')
    expect(isLocalOnlyPath('notes.local.draft.md')).toBe(true)
    expect(isLocalOnlyPath(copy)).toBe(true)
  })

  it('treats a dotfile as a name, not an extension', () => {
    // `.gitignore` is entirely a name: the dot is at index 0, and `dot > 0`
    // is what keeps it from becoming ' copy.gitignore'.
    const taken = (p: string) => p === '.gitignore'
    expect(freeCopyPath(taken, '.gitignore')).toBe('.gitignore copy')
  })
})
