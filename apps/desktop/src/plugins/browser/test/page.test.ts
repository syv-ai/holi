/** What a typed address means, and what a tab may show (docs/features/browser.md). */
import { describe, expect, it } from 'vitest'
import { addressFor, isPageUrl, pageLabel } from '../shared/page'

describe('addressFor', () => {
  it('keeps a web address as it is', () => {
    expect(addressFor('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(addressFor('  http://example.com  ')).toBe('http://example.com')
  })

  it('reads a bare host as https, and this machine as http', () => {
    expect(addressFor('example.com')).toBe('https://example.com')
    expect(addressFor('docs.github.com/en/rest')).toBe('https://docs.github.com/en/rest')
    expect(addressFor('localhost:3000')).toBe('http://localhost:3000')
    expect(addressFor('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x')
  })

  it('searches for anything else', () => {
    expect(addressFor('holi markdown vault')).toBe(
      'https://duckduckgo.com/?q=holi%20markdown%20vault',
    )
    expect(addressFor('readme')).toBe('https://duckduckgo.com/?q=readme')
  })

  it('refuses a scheme a tab may not show, and nothing at all', () => {
    expect(addressFor('file:///etc/passwd')).toBeNull()
    expect(addressFor('javascript:alert(1)')).toBeNull()
    expect(addressFor('holi-app://x/index.html')).toBeNull()
    expect(addressFor('   ')).toBeNull()
  })
})

it('a tab shows the web and the blank page, nothing else', () => {
  expect(isPageUrl('https://example.com')).toBe(true)
  expect(isPageUrl('about:blank')).toBe(true)
  for (const url of [
    'file:///x',
    'holi-vault://a/b.png',
    'data:text/html,hi',
    'mailto:a@b.c',
    'nope',
  ]) {
    expect(isPageUrl(url)).toBe(false)
  }
})

it("a tab is named by its page's title, else its host, else New Tab", () => {
  expect(pageLabel({ title: ' Pricing ', url: 'https://example.com/p' })).toBe('Pricing')
  expect(pageLabel({ title: '', url: 'https://www.example.com/p' })).toBe('example.com')
  expect(pageLabel({ title: '', url: '' })).toBe('New Tab')
})
