import { describe, expect, it } from 'vitest'
import { humanizeTitle, scaffoldNoteText } from '../src/renderer/src/lib/scaffold'

describe('humanizeTitle', () => {
  it('strips the folder, extension, and separators', () => {
    expect(humanizeTitle('notes/meeting-notes.md')).toBe('Meeting notes')
    expect(humanizeTitle('my_first_idea.md')).toBe('My first idea')
    expect(humanizeTitle('README.md')).toBe('README')
  })

  it('handles a bare name with no extension', () => {
    expect(humanizeTitle('scratch')).toBe('Scratch')
  })
})

describe('scaffoldNoteText', () => {
  it('emits a title + created frontmatter block followed by a blank body', () => {
    expect(scaffoldNoteText('ideas/big-plan.md', '2026-07-23')).toBe(
      '---\ntitle: Big plan\ncreated: 2026-07-23\n---\n\n',
    )
  })
})
