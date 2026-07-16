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

  // A markdown link is real editable text: a plain click must keep placing the caret,
  // or you could never edit the link text.
  it('leaves a markdown link alone without a modifier', () => {
    expect(resolveLinkClick({ href: 'https://example.com', modifier: false })).toBeNull()
  })

  it('opens an http(s) markdown link externally on ⌘/Ctrl-click', () => {
    expect(resolveLinkClick({ href: 'https://example.com', modifier: true })).toEqual({
      kind: 'external',
      url: 'https://example.com',
    })
    expect(resolveLinkClick({ href: 'HTTP://Example.com', modifier: true })).toEqual({
      kind: 'external',
      url: 'HTTP://Example.com',
    })
  })

  // A relative href is a vault path — handing it to the OS would open nothing.
  it('routes a relative markdown link internally, not to the OS', () => {
    expect(resolveLinkClick({ href: 'notes/b.md', modifier: true })).toEqual({
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
