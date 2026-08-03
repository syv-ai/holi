import { describe, expect, it } from 'vitest'
import { noteTitleFromPath, previewFromMarkdown } from '../src/renderer/src/editor/notePreview'

describe('previewFromMarkdown', () => {
  it('takes the first heading as the title and the next lines as the snippet', () => {
    const text = '# My Note\n\nFirst para.\nSecond line.\nThird line.\nFourth line.'
    expect(previewFromMarkdown(text)).toEqual({
      title: 'My Note',
      lines: ['First para.', 'Second line.', 'Third line.'],
    })
  })

  it('strips YAML frontmatter before reading', () => {
    const text = '---\ntitle: x\ntags: [a]\n---\n# Heading\nbody line'
    expect(previewFromMarkdown(text)).toEqual({ title: 'Heading', lines: ['body line'] })
  })

  it('returns a null title when the note does not open with a heading', () => {
    const text = 'just prose\n\nmore prose'
    expect(previewFromMarkdown(text)).toEqual({ title: null, lines: ['just prose', 'more prose'] })
  })

  it('skips blank lines and caps the snippet at three lines', () => {
    const text = '\n\nalpha\n\nbeta\ngamma\ndelta'
    expect(previewFromMarkdown(text)).toEqual({ title: null, lines: ['alpha', 'beta', 'gamma'] })
  })
})

describe('noteTitleFromPath', () => {
  it('is the basename without the .md extension', () => {
    expect(noteTitleFromPath('projects/q2/plan.md')).toBe('plan')
    expect(noteTitleFromPath('root.md')).toBe('root')
  })
})
