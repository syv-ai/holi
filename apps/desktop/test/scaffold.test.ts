import { describe, expect, it } from 'vitest'
import { scaffoldNoteText } from '../src/renderer/src/lib/scaffold'

describe('scaffoldNoteText', () => {
  it('emits created + empty tags frontmatter, no title (the filename is identity)', () => {
    expect(scaffoldNoteText('2026-07-23')).toBe('---\ncreated: 2026-07-23\ntags: []\n---\n\n')
  })
})
