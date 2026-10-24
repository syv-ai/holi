import { describe, expect, it } from 'vitest'
import { fileSlug } from '../src/file-slug'

const slug = (title: string, max?: number) =>
  fileSlug(title, { fallback: 'x', ...(max === undefined ? {} : { max }) })

describe('fileSlug', () => {
  it('is lower case, with dashes for spaces', () => {
    expect(slug('Q3 Strategy Deck')).toBe('q3-strategy-deck')
  })

  it('writes out æ, ø and å, and drops other accents', () => {
    expect(slug('Møde om næste skridt på Ærø')).toBe('moede-om-naeste-skridt-paa-aeroe')
    expect(slug('Café Ümlaut Straße')).toBe('cafe-umlaut-strasse')
  })

  it('makes every other character a separator, so nothing moves the file', () => {
    expect(slug('a/../../etc/passwd')).toBe('a-etc-passwd')
    expect(slug('notes.local.md · Pull Request #189 ·')).toBe('notes-local-md-pull-request-189')
  })

  it('cuts at a whole word, and is never empty', () => {
    expect(slug('one two three', 9)).toBe('one-two')
    expect(slug('!!!')).toBe('x')
  })
})
