import { describe, expect, it } from 'vitest'
import { resolveLinkClick } from '../src/renderer/src/editor/links'

describe('resolveLinkClick (FR-6 wiki-links, FR-7 markdown links)', () => {
  it('opens a wiki-link chip on a plain click', () => {
    expect(resolveLinkClick({ wikiTarget: 'notes/a.md', modifier: false })).toEqual({
      kind: 'note',
      path: 'notes/a.md',
    })
  })

  // The chip is a replaced widget — there is no caret position inside it to want, so a
  // modifier would be ceremony for the only thing the click can mean.
  it('needs no modifier for a chip', () => {
    expect(resolveLinkClick({ wikiTarget: 'a.md', modifier: true })).toEqual({
      kind: 'note',
      path: 'a.md',
    })
  })

  // A rendered markdown link (data-href present only on a non-active line) navigates on
  // a plain click, like a wiki-link — the modifier requirement made navigation
  // unreachable, because any click un-rendered the link before ⌘ could land.
  it('opens an http(s) markdown link externally on a plain click', () => {
    expect(resolveLinkClick({ href: 'https://example.com', modifier: false })).toEqual({
      kind: 'external',
      url: 'https://example.com',
    })
    expect(resolveLinkClick({ href: 'HTTP://Example.com', modifier: false })).toEqual({
      kind: 'external',
      url: 'HTTP://Example.com',
    })
  })

  // A modifier still works — it is simply no longer required.
  it('still opens on ⌘/Ctrl-click', () => {
    expect(resolveLinkClick({ href: 'https://example.com', modifier: true })).toEqual({
      kind: 'external',
      url: 'https://example.com',
    })
  })

  // A relative href is a vault path — handing it to the OS would open nothing.
  it('routes a relative markdown link internally, not to the OS', () => {
    expect(resolveLinkClick({ href: 'notes/b.md', modifier: false })).toEqual({
      kind: 'note',
      path: 'notes/b.md',
    })
  })

  it('prefers the chip when a click is inside both', () => {
    expect(resolveLinkClick({ wikiTarget: 'a.md', href: 'https://example.com', modifier: true })).toEqual({
      kind: 'note',
      path: 'a.md',
    })
  })

  // A task chip carries a stable id (D27), not a path, and opens the board's detail
  // panel — so it must route by its own dataset key and never reach openNote.
  it('opens a task chip on a plain click', () => {
    expect(resolveLinkClick({ taskTarget: 'task-123', modifier: false })).toEqual({
      kind: 'task',
      id: 'task-123',
    })
  })

  it('prefers a task chip over an enclosing markdown link', () => {
    expect(
      resolveLinkClick({ taskTarget: 'task-123', href: 'https://example.com', modifier: true }),
    ).toEqual({ kind: 'task', id: 'task-123' })
  })

  it('ignores a click on ordinary text', () => {
    expect(resolveLinkClick({ modifier: false })).toBeNull()
    expect(resolveLinkClick({ modifier: true })).toBeNull()
  })
})
