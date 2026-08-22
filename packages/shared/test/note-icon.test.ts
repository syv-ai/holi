import { describe, expect, it } from 'vitest'
import { noteIcon } from '../src/note-icon'

const fm = (...lines: string[]) => `---\n${lines.join('\n')}\n---\n\nBody text.\n`

describe('noteIcon', () => {
  it('reads a single emoji from the leading frontmatter block', () => {
    expect(noteIcon(fm('type: note', 'icon: 🎯'))).toBe('🎯')
  })

  it('tolerates the spacing YAML allows around the value', () => {
    expect(noteIcon(fm('icon:🎯'))).toBe('🎯')
    expect(noteIcon(fm('icon:   🎯   '))).toBe('🎯')
    expect(noteIcon(fm('icon: 🎯\t'))).toBe('🎯')
  })

  it('unwraps a quoted value, since a YAML editor may well add quotes', () => {
    expect(noteIcon(fm("icon: '🎯'"))).toBe('🎯')
    expect(noteIcon(fm('icon: "🎯"'))).toBe('🎯')
  })

  it('normalizes CRLF, so a file authored on Windows still resolves', () => {
    expect(noteIcon('---\r\nicon: 🎯\r\n---\r\n\r\nBody.\r\n')).toBe('🎯')
  })

  it('accepts the emoji forms a picker or keyboard actually produces', () => {
    // One grapheme each, but several code points: skin tone, ZWJ, flag, keycap.
    expect(noteIcon(fm('icon: 👍🏽'))).toBe('👍🏽')
    expect(noteIcon(fm('icon: 👩‍💻'))).toBe('👩‍💻')
    expect(noteIcon(fm('icon: 🇩🇰'))).toBe('🇩🇰')
    expect(noteIcon(fm('icon: #️⃣'))).toBe('#️⃣')
    expect(noteIcon(fm('icon: ▶️'))).toBe('▶️')
  })

  /**
   * The macOS emoji picker appends U+FE0F to emoji that already default to
   * emoji presentation, and `RGI_Emoji` does not contain those sequences — it
   * lists `\u2b50`, never `\u2b50\ufe0f`. Picking a star from the palette
   * therefore produced a value the validator refused, and the note silently
   * kept its markdown glyph. Emoji split into two classes here and the rule has
   * to cover both, which is why the check is not a single regex test.
   */
  it("accepts the redundant variation selector a picker adds", () => {
    // Emoji-presentation by default: RGI has the bare form only.
    expect(noteIcon(fm('icon: \u2b50\ufe0f'))).toBe('\u2b50\ufe0f')
    expect(noteIcon(fm('icon: \u2705\ufe0f'))).toBe('\u2705\ufe0f')
    expect(noteIcon(fm('icon: \u26a1\ufe0f'))).toBe('\u26a1\ufe0f')
  })

  it('still accepts the forms where the selector is required, not redundant', () => {
    // Text-presentation by default: RGI has the VS16 form only, and stripping
    // it would leave a dingbat that is not an emoji at all.
    expect(noteIcon(fm('icon: \u2764\ufe0f'))).toBe('\u2764\ufe0f')
    expect(noteIcon(fm('icon: \u25b6\ufe0f'))).toBe('\u25b6\ufe0f')
    expect(noteIcon(fm('icon: \u2611\ufe0f'))).toBe('\u2611\ufe0f')
  })

  it('returns the emoji exactly as the file spells it', () => {
    // Both spellings of a star are accepted and neither is rewritten: the file
    // is the truth, and the two render identically anyway.
    expect(noteIcon(fm('icon: \u2b50'))).toBe('\u2b50')
    expect(noteIcon(fm('icon: \u2b50\ufe0f'))).toBe('\u2b50\ufe0f')
  })

  it('does not let the selector smuggle a non-emoji through', () => {
    // Stripping VS16 must not turn "not an emoji" into "an emoji".
    expect(noteIcon(fm('icon: A\ufe0f'))).toBeUndefined()
    expect(noteIcon(fm('icon: \ufe0f'))).toBeUndefined()
    expect(noteIcon(fm('icon: \u2b50\ufe0f\u2b50\ufe0f'))).toBeUndefined()
  })

  it('is undefined when the note has no icon to offer', () => {
    expect(noteIcon(fm('type: note'))).toBeUndefined()
    expect(noteIcon('Just a body, no frontmatter.\n')).toBeUndefined()
    expect(noteIcon('')).toBeUndefined()
  })

  // The isDaily lesson: a horizontal rule plus the right words further down the
  // note must not be read as frontmatter. Only the LEADING block counts.
  it('ignores an icon: line that is not in the leading block', () => {
    expect(noteIcon('Body first.\n\n---\nicon: 🎯\n---\n')).toBeUndefined()
    expect(noteIcon(fm('type: note') + '\n---\nicon: 🎯\n---\n')).toBeUndefined()
  })

  it('ignores an indented icon:, which in YAML belongs to some other key', () => {
    expect(noteIcon(fm('meta:', '  icon: 🎯'))).toBeUndefined()
  })

  // Unterminated frontmatter is a malformed file, not an exception: the tree
  // renders every note, so this must degrade to the type glyph.
  it('returns undefined rather than throwing on unterminated frontmatter', () => {
    expect(noteIcon('---\nicon: 🎯\n\nBody with no closing fence.\n')).toBeUndefined()
  })

  // The value lands in a fixed-size tree row, so anything that is not exactly
  // one emoji is refused outright rather than truncated.
  it('refuses a value that is not a single emoji', () => {
    expect(noteIcon(fm('icon: 🎯🎯'))).toBeUndefined()
    expect(noteIcon(fm('icon: A'))).toBeUndefined()
    expect(noteIcon(fm('icon: rocket'))).toBeUndefined()
    expect(noteIcon(fm('icon: 🎯 Roadmap'))).toBeUndefined()
    expect(noteIcon(fm('icon:'))).toBeUndefined()
    expect(noteIcon(fm("icon: ''"))).toBeUndefined()
  })
})
