import { describe, expect, test } from 'vitest'
import { firstHeading, setFirstHeading } from '../src/headings'

describe('firstHeading', () => {
  test('reads the first heading at any level', () => {
    expect(firstHeading('# Fix the tap')).toBe('Fix the tap')
    expect(firstHeading('### Fix the tap')).toBe('Fix the tap')
  })

  test('takes the FIRST heading, not the biggest', () => {
    // "Regardless of level" cuts both ways: a body that opens with `###` and
    // later carries an `#` is named by the one you wrote first.
    expect(firstHeading('### Call the plumber\n\n# Notes')).toBe('Call the plumber')
  })

  test('finds a heading that is not the first line', () => {
    expect(firstHeading('some prose first\n\n## The real title')).toBe('The real title')
  })

  test('a body with no heading has no title', () => {
    expect(firstHeading('')).toBeNull()
    expect(firstHeading('just prose\nand more prose')).toBeNull()
  })

  test('skips fenced code, backtick and tilde alike', () => {
    // The reason this is not a one-line regex. A shell block would otherwise
    // name the task after a comment someone pasted.
    expect(firstHeading('```sh\n# not a heading\n```\n\n# The heading')).toBe('The heading')
    expect(firstHeading('~~~\n# nope\n~~~\n\n## Yes')).toBe('Yes')
  })

  test('a fence only closes on its own character', () => {
    expect(firstHeading('~~~\n```\n# still inside\n```\n~~~\n\n# Out')).toBe('Out')
  })

  test('four spaces is an indented code block, three is still a heading', () => {
    expect(firstHeading('    # indented code')).toBeNull()
    expect(firstHeading('   # three spaces')).toBe('three spaces')
  })

  test('a closing run of hashes is decoration', () => {
    expect(firstHeading('# Fix the tap #')).toBe('Fix the tap')
    expect(firstHeading('## Fix the tap ###')).toBe('Fix the tap')
  })

  test('an empty heading names nothing, so the next one wins', () => {
    expect(firstHeading('#\n\n# Real')).toBe('Real')
  })

  test('a hash with no space is not a heading', () => {
    // `#tag` is a tag, and naming a task after one would be a surprise.
    expect(firstHeading('#tag not a heading')).toBeNull()
  })
})

describe('setFirstHeading', () => {
  test('prepends a heading to a body that has none', () => {
    expect(setFirstHeading('', 'Fix the tap')).toBe('# Fix the tap\n')
    expect(setFirstHeading('call them', 'Fix the tap')).toBe('# Fix the tap\n\ncall them\n')
  })

  test('replaces the text of an existing heading, keeping its level', () => {
    // `##` was a choice about the document, not about the title.
    expect(setFirstHeading('## Old\n\nbody', 'New')).toBe('## New\n\nbody')
  })

  test('does not rewrite a hash inside a fence', () => {
    const body = '```sh\n# comment\n```\n'
    expect(setFirstHeading(body, 'Title')).toBe('# Title\n\n```sh\n# comment\n```\n')
  })

  test('round-trips with firstHeading', () => {
    expect(firstHeading(setFirstHeading('body text', 'Fix the tap'))).toBe('Fix the tap')
    expect(firstHeading(setFirstHeading('# Old\n\nbody', 'Fix the tap'))).toBe('Fix the tap')
  })
})
