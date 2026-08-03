import { describe, expect, it } from 'vitest'
import { resolveLinkClick } from './links'

describe('resolveLinkClick', () => {
  it('routes a wiki target (note or task path) to a note action', () => {
    expect(resolveLinkClick({ wikiTarget: 'p/task.a.md', modifier: false })).toEqual({
      kind: 'note',
      path: 'p/task.a.md',
    })
  })

  it('a plain markdown-link click places the caret (null); ⌘-click navigates', () => {
    expect(resolveLinkClick({ href: 'notes/b.md', modifier: false })).toBeNull()
    expect(resolveLinkClick({ href: 'notes/b.md', modifier: true })).toEqual({
      kind: 'note',
      path: 'notes/b.md',
    })
  })

  it('⌘-click on an http link leaves the app', () => {
    expect(resolveLinkClick({ href: 'https://x.dev', modifier: true })).toEqual({
      kind: 'external',
      url: 'https://x.dev',
    })
  })

  it('a bare click that hit nothing is left alone', () => {
    expect(resolveLinkClick({ modifier: false })).toBeNull()
  })
})
