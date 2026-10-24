/**
 * The link file format (docs/features/links.md).
 */
import { describe, expect, it } from 'vitest'
import {
  isLinkFilePath,
  linkFilePath,
  linkFileText,
  linkTitle,
  parseLinkFile,
} from '../shared/link-file'

describe('isLinkFilePath', () => {
  it('is the name that decides', () => {
    expect(isLinkFilePath('link.Q3 deck.md')).toBe(true)
    expect(isLinkFilePath('decks/link.Q3 deck.local.md')).toBe(true)
    expect(isLinkFilePath('Q3 deck.md')).toBe(false)
    expect(isLinkFilePath('links/notes.md')).toBe(false)
    expect(isLinkFilePath('link..md')).toBe(false)
  })
})

describe('linkFilePath', () => {
  it('keeps a title readable, and never lets it move the file', () => {
    expect(linkFilePath('', 'Q3 strategy deck')).toBe('link.Q3 strategy deck.md')
    expect(linkFilePath('decks', 'Q3: deck/v2 [draft] #1')).toBe('decks/link.Q3 deck v2 draft 1.md')
    expect(linkFilePath('', '../..')).toBe('link.link.md')
    expect(linkTitle(linkFilePath('a', 'Q3 deck'))).toBe('Q3 deck')
  })

  it('numbers a second of a name after cutting it to length', () => {
    const long = 'x'.repeat(200)
    expect(linkFilePath('', long, 2)).not.toBe(linkFilePath('', long))
    expect(linkFilePath('', long, 2).endsWith(' 2.md')).toBe(true)
  })

  it('cuts a long title at a word, without a dangling separator', () => {
    const title =
      'Browse and edit Claude auto-memory from Dash by FabianScott · Pull Request #189 · syv-ai/dash'
    expect(linkFilePath('', title)).toBe(
      'link.Browse and edit Claude auto-memory from Dash by FabianScott · Pull Request 189.md',
    )
  })

  it('never names a link local by its title', () => {
    expect(linkFilePath('', 'notes.local')).toBe('link.notes.md')
    expect(linkFilePath('', 'a.local.b')).toBe('link.a .b.md')
  })
})

describe('parseLinkFile', () => {
  it('reads what a new file holds back', () => {
    const text = linkFileText('https://example.com/a?b=1#c')
    expect(parseLinkFile(text, 'link.a.md')).toEqual({
      path: 'link.a.md',
      url: 'https://example.com/a?b=1#c',
      tags: [],
    })
    expect(text.endsWith('---\n')).toBe(true)
  })

  it('reads tags', () => {
    const text = '---\nurl: https://x.org\ntags: [a, b]\n---\n'
    expect(parseLinkFile(text, 'link.x.md').tags).toEqual(['a', 'b'])
  })

  it('refuses a file with no web address, so the scan reports it', () => {
    expect(() => parseLinkFile('just text', 'link.x.md')).toThrow(/needs a `url`/)
    expect(() => parseLinkFile('---\nurl: file:///etc/passwd\n---\n', 'link.x.md')).toThrow(
      /http\(s\)/,
    )
  })
})
