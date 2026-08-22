import { describe, expect, it } from 'vitest'
import { resolveIconMap, withIcon } from '../src/icon-map'

const json = (o: unknown) => JSON.stringify(o)

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

  it('accepts the emoji spellings a picker produces, exactly as noteIcon does', () => {
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

describe('withIcon', () => {
  const parse = (s: string) => JSON.parse(s) as Record<string, string>

  it('sets an icon on a vault with no map yet', () => {
    expect(parse(withIcon(null, 'AGENTS.md', '🤖'))).toEqual({ 'AGENTS.md': '🤖' })
  })

  it('replaces the entry for a path that already has one', () => {
    const before = json({ 'AGENTS.md': '🤖', 'MEMORY.md': '🧠' })
    expect(parse(withIcon(before, 'AGENTS.md', '👽'))).toEqual({
      'AGENTS.md': '👽',
      'MEMORY.md': '🧠',
    })
  })

  it('clears an entry when handed null, leaving the others', () => {
    const before = json({ 'AGENTS.md': '🤖', 'MEMORY.md': '🧠' })
    expect(parse(withIcon(before, 'AGENTS.md', null))).toEqual({ 'MEMORY.md': '🧠' })
  })

  it('clearing a path that was never there is not an error', () => {
    expect(parse(withIcon(json({ a: '🎯' }), 'b', null))).toEqual({ a: '🎯' })
  })

  it('does not leave two spellings of one path behind', () => {
    // `Clients/` and `Clients` are the same folder; editing one must not add
    // a second line that claims it too.
    expect(parse(withIcon(json({ 'Clients/': '👥' }), 'Clients', '📅'))).toEqual({
      Clients: '📅',
    })
  })

  it('writes keys sorted, so committing an icon does not churn the diff', () => {
    const out = withIcon(json({ z: '🎯', a: '🧠' }), 'm', '👥')
    expect(Object.keys(parse(out))).toEqual(['a', 'm', 'z'])
  })

  it('ends with a newline, like every other file the vault commits', () => {
    expect(withIcon(null, 'a.md', '🎯').endsWith('}\n')).toBe(true)
  })

  it('refuses to write something that is not a single emoji', () => {
    expect(() => withIcon(null, 'a.md', 'rocket')).toThrow()
    expect(() => withIcon(null, 'a.md', '🎯🎯')).toThrow()
  })

  it('leaves a hand-written key it cannot normalize alone rather than deleting it', () => {
    // Editing one entry must not quietly prune lines a person wrote.
    const out = parse(withIcon(json({ '../odd': '🎯', a: '🧠' }), 'a', '👥'))
    expect(out['../odd']).toBe('🎯')
  })
})
