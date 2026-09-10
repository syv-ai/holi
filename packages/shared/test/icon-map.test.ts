import { parse, stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import { resolveIconMap, withIcon } from '../src/icon-map'

const json = (o: unknown) => stringify(o)

describe('resolveIconMap', () => {
  it('reads a committed map', () => {
    const { icons } = resolveIconMap(json({ 'AGENTS.md': '🤖', Clients: '👥' }), null)
    expect(icons).toEqual({ 'AGENTS.md': '🤖', Clients: '👥' })
  })

  it('lets the local file override per key, leaving the rest of the shared map', () => {
    // The theme's rule (D64), for the same reason: a one-line personal file
    // should recolour one entry and inherit everything else.
    const { icons } = resolveIconMap(
      json({ 'AGENTS.md': '🤖', 'MEMORY.md': '🧠' }),
      json({ 'AGENTS.md': '👽' }),
    )
    expect(icons).toEqual({ 'AGENTS.md': '👽', 'MEMORY.md': '🧠' })
  })

  it('normalizes a key the way every other vault path is normalized', () => {
    // A folder is natural to write with a trailing slash, and `./` is what a
    // shell completion leaves behind. Both name the same folder.
    const { icons } = resolveIconMap(json({ 'Clients/': '👥', './docs': '📘' }), null)
    expect(icons).toEqual({ Clients: '👥', docs: '📘' })
  })

  it('drops an entry that is not a single emoji and keeps the others', () => {
    const { icons, warnings } = resolveIconMap(
      json({ good: '🎯', wordy: 'rocket', two: '🎯🎯', empty: '' }),
      null,
    )
    expect(icons).toEqual({ good: '🎯' })
    expect(warnings).toHaveLength(3)
  })

  it('accepts the emoji spellings a picker produces', () => {
    const { icons } = resolveIconMap(json({ a: '⭐️', b: '❤️', c: '⚙', d: '👩‍💻' }), null)
    expect(Object.keys(icons)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('refuses a key that reaches outside the vault', () => {
    const { icons, warnings } = resolveIconMap(
      json({ '../secrets.md': '🔓', '/etc/passwd': '🔓', ok: '🎯' }),
      null,
    )
    expect(icons).toEqual({ ok: '🎯' })
    expect(warnings).toHaveLength(2)
  })

  it('drops a value that is not a string at all', () => {
    const { icons } = resolveIconMap(json({ a: 7, b: null, c: { d: '🎯' }, e: '🎯' }), null)
    expect(icons).toEqual({ e: '🎯' })
  })

  // A vault with no icons, a half-written file, or something that is not a map
  // at all must all resolve to "no icons" — never to a thrown scan.
  it('degrades to an empty map rather than throwing', () => {
    expect(resolveIconMap(null, null).icons).toEqual({})
    expect(resolveIconMap('{ not json', null).icons).toEqual({})
    expect(resolveIconMap(json(['🎯']), null).icons).toEqual({})
    expect(resolveIconMap(json('🎯'), null).icons).toEqual({})
    expect(resolveIconMap(json(null), null).icons).toEqual({})
    expect(resolveIconMap('', null).icons).toEqual({})
  })

  it('says what it dropped, so a typo is findable', () => {
    const { warnings } = resolveIconMap(json({ 'a.md': 'nope' }), null)
    expect(warnings[0]).toContain('a.md')
  })
})

describe('what counts as an emoji', () => {
  const v = (emoji: string) => resolveIconMap(json({ 'a.md': emoji }), null).icons['a.md']

  it('accepts the plain single-codepoint emoji', () => {
    expect(v('🎯')).toBe('🎯')
    expect(v('🫶')).toBe('🫶')
  })

  it('accepts the composed forms a picker or keyboard produces', () => {
    // One grapheme each, several codepoints: skin tone, ZWJ, flag, keycap.
    expect(v('👍🏽')).toBe('👍🏽')
    expect(v('👩‍💻')).toBe('👩‍💻')
    expect(v('🇩🇰')).toBe('🇩🇰')
    expect(v('#️⃣')).toBe('#️⃣')
  })

  /**
   * The macOS picker appends U+FE0F to emoji that already default to emoji
   * presentation, and `RGI_Emoji` does not contain those sequences — it lists
   * `\u2b50`, never `\u2b50\ufe0f`. Picking a star from the palette produced a
   * value that was silently refused, and the row kept its plain glyph.
   */
  it('accepts the redundant variation selector a picker adds', () => {
    expect(v('\u2b50\ufe0f')).toBe('\u2b50\ufe0f')
    expect(v('\u2705\ufe0f')).toBe('\u2705\ufe0f')
  })

  it('still accepts the forms where the selector is required, not redundant', () => {
    // Text-presentation by default: RGI has the VS16 form only, and stripping
    // it would leave a dingbat that is not an emoji at all.
    expect(v('\u2764\ufe0f')).toBe('\u2764\ufe0f')
    expect(v('\u25b6\ufe0f')).toBe('\u25b6\ufe0f')
  })

  it('accepts a pictograph written without its selector', () => {
    // RGI is strictly right that a bare text-presentation character is not an
    // emoji — but it looks like one to whoever typed it, and copying a symbol
    // out of a web page is enough to land here.
    expect(v('\u2764')).toBe('\u2764')
    expect(v('\u2699')).toBe('\u2699')
    expect(v('\u{1f5d3}')).toBe('\u{1f5d3}')
  })

  it('stores the emoji exactly as written, never re-normalized', () => {
    expect(v('\u2b50')).toBe('\u2b50')
    expect(v('\u2b50\ufe0f')).toBe('\u2b50\ufe0f')
  })

  it('refuses anything that is not one emoji', () => {
    for (const bad of ['A', '7', 'rocket', '🎯🎯', '', '🎯 Roadmap', '→', '①', '日', 'A\ufe0f', '\ufe0f']) {
      expect(v(bad)).toBeUndefined()
    }
  })
})

describe('withIcon', () => {
  const read = (s: string) => parse(s) as Record<string, string>

  it('sets an icon on a vault with no map yet', () => {
    expect(read(withIcon(null, 'AGENTS.md', '🤖'))).toEqual({ 'AGENTS.md': '🤖' })
  })

  it('replaces the entry for a path that already has one', () => {
    const before = json({ 'AGENTS.md': '🤖', 'MEMORY.md': '🧠' })
    expect(read(withIcon(before, 'AGENTS.md', '👽'))).toEqual({
      'AGENTS.md': '👽',
      'MEMORY.md': '🧠',
    })
  })

  it('clears an entry when handed null, leaving the others', () => {
    const before = json({ 'AGENTS.md': '🤖', 'MEMORY.md': '🧠' })
    expect(read(withIcon(before, 'AGENTS.md', null))).toEqual({ 'MEMORY.md': '🧠' })
  })

  it('clearing a path that was never there is not an error', () => {
    expect(read(withIcon(json({ a: '🎯' }), 'b', null))).toEqual({ a: '🎯' })
  })

  it('does not leave two spellings of one path behind', () => {
    // `Clients/` and `Clients` are the same folder; editing one must not add
    // a second line that claims it too.
    expect(read(withIcon(json({ 'Clients/': '👥' }), 'Clients', '📅'))).toEqual({
      Clients: '📅',
    })
  })

  it('writes keys sorted, so committing an icon does not churn the diff', () => {
    const out = withIcon(json({ z: '🎯', a: '🧠' }), 'm', '👥')
    expect(Object.keys(parse(out))).toEqual(['a', 'm', 'z'])
  })

  it('ends with a newline, like every other file the vault commits', () => {
    // The closing brace went with the move to YAML; the newline is the part
    // that mattered, and git still cares about it.
    expect(withIcon(null, 'a.md', '🎯').endsWith('\n')).toBe(true)
  })

  it('refuses to write something that is not a single emoji', () => {
    expect(() => withIcon(null, 'a.md', 'rocket')).toThrow()
    expect(() => withIcon(null, 'a.md', '🎯🎯')).toThrow()
  })

  it('leaves a hand-written key it cannot normalize alone rather than deleting it', () => {
    // Editing one entry must not quietly prune lines a person wrote.
    const out = read(withIcon(json({ '../odd': '🎯', a: '🧠' }), 'a', '👥'))
    expect(out['../odd']).toBe('🎯')
  })
})
