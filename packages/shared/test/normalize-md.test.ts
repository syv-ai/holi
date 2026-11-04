import { describe, expect, test } from 'vitest'

import { differsBeyondTidy } from '../src/normalize-md'

describe('differsBeyondTidy', () => {
  test('the same text is nothing new', () => {
    expect(differsBeyondTidy('Alpha\n', 'Alpha\n', 'a.md')).toBe(false)
  })

  test('what the commit tidy strips is nothing new, either way round', () => {
    expect(differsBeyondTidy('Alpha \n\nBeta', 'Alpha\n\nBeta\n', 'a.md')).toBe(false)
    expect(differsBeyondTidy('Alpha\n\nBeta\n', 'Alpha \n\nBeta', 'a.md')).toBe(false)
  })

  test('a word is new', () => {
    expect(differsBeyondTidy('Alpha\n', 'Alpha beta\n', 'a.md')).toBe(true)
  })

  test('outside markdown a trailing space is content', () => {
    expect(differsBeyondTidy('KEY=1\n', 'KEY=1 \n', '.env')).toBe(true)
  })
})
