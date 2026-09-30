/**
 * Bare links in a note's prose: which text is a link, and where it goes. What
 * counts as prose (not code, not an existing link) is live preview's side.
 */
import { describe, expect, it } from 'vitest'
import { bareLinks } from '../src/renderer/src/editor/bare-links'

const urls = (text: string): string[] => bareLinks(text).map((l) => l.url)

describe('bareLinks', () => {
  it('finds bare domains, with or without a path', () => {
    expect(
      urls('login.microsoftonline.com and graph.microsoft.com/v1.0/me and retsinformation-api.dk'),
    ).toEqual([
      'https://login.microsoftonline.com',
      'https://graph.microsoft.com/v1.0/me',
      'https://retsinformation-api.dk',
    ])
  })

  it('opens a bare domain over https', () => {
    expect(urls('see github.com')).toEqual(['https://github.com'])
    expect(urls('see www.example.com')).toEqual(['https://www.example.com'])
  })

  it('keeps a written scheme', () => {
    expect(urls('see http://example.com/a and https://github.com/x')).toEqual([
      'http://example.com/a',
      'https://github.com/x',
    ])
  })

  it('gives the range the link covers, leaving sentence punctuation out', () => {
    const text = 'Go to github.com.'
    const [link] = bareLinks(text)
    expect(text.slice(link!.from, link!.to)).toBe('github.com')
  })

  it('leaves file names alone, even where the extension is a country domain', () => {
    expect(urls('edit notes.md, main.py, run.sh and lib.rs')).toEqual([])
  })

  it('leaves email addresses alone', () => {
    expect(urls('mail ada@syv.ai')).toEqual([])
  })

  it('knows the newer top-level domains', () => {
    expect(urls('try holi.app and web.dev')).toEqual(['https://holi.app', 'https://web.dev'])
  })
})
