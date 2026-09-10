import { parse, stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import {
  THEME_TOKENS,
  parseVaultTheme,
  resolveTheme,
  themeBlockToVars,
  THEME_TOKEN_GROUPS,
  THEME_TOKEN_NOTES,
  themeTokenKind,
  themeTokenLabel,
  parseThemePatch,
  applyThemePatch,
} from '../src/theme'

describe('parseVaultTheme', () => {
  it('parses a well-formed theme object', () => {
    const theme = parseVaultTheme('{"dark":{"primary":"#3b82f6"}}')
    expect(theme).toEqual({ dark: { primary: '#3b82f6' } })
  })

  it('returns null on malformed JSON (never throws)', () => {
    expect(parseVaultTheme('{ not json')).toBeNull()
    expect(parseVaultTheme('')).toBeNull()
  })

  it('returns null when the top level is not an object', () => {
    expect(parseVaultTheme('"a string"')).toBeNull()
    expect(parseVaultTheme('[1,2,3]')).toBeNull()
    expect(parseVaultTheme('null')).toBeNull()
    expect(parseVaultTheme('42')).toBeNull()
  })
})

describe('resolveTheme — whitelist', () => {
  it('keeps whitelisted color + chrome tokens', () => {
    const { dark } = resolveTheme(
      stringify({
        dark: {
          primary: '#3b82f6',
          background: 'oklch(0.16 0 0)',
          radius: '0.75rem',
          'shadow-popover': '0 1px 3px rgb(0 0 0 / 0.4)',
          'scrollbar-thumb': '#3f3f46',
          selection: '#3b82f6',
        },
      }),
      null,
    )
    expect(dark).toEqual({
      primary: '#3b82f6',
      background: 'oklch(0.16 0 0)',
      radius: '0.75rem',
      'shadow-popover': '0 1px 3px rgb(0 0 0 / 0.4)',
      'scrollbar-thumb': '#3f3f46',
      selection: '#3b82f6',
    })
  })

  it('drops unknown keys with a warning, keeping the rest', () => {
    const { dark, warnings } = resolveTheme(
      stringify({ dark: { primary: '#fff', width: '50px', notAToken: 'x' } }),
      null,
    )
    expect(dark).toEqual({ primary: '#fff' })
    expect(warnings.some((w) => w.includes('width'))).toBe(true)
    expect(warnings.some((w) => w.includes('notAToken'))).toBe(true)
  })

  it('has no layout tokens in the whitelist at all', () => {
    for (const banned of ['width', 'height', 'padding', 'margin', 'position', 'top', 'display', 'gap']) {
      expect(THEME_TOKENS).not.toContain(banned)
    }
  })
})

describe('resolveTheme — validation', () => {
  it('keeps valid color forms (hex, rgb, hsl, oklch, named)', () => {
    const { dark } = resolveTheme(
      stringify({
        dark: {
          primary: '#3b82f6',
          secondary: 'rgb(59 130 246)',
          accent: 'hsl(217 91% 60%)',
          muted: 'oklch(0.6 0.1 250)',
          border: 'transparent',
        },
      }),
      null,
    )
    expect(Object.keys(dark).sort()).toEqual(['accent', 'border', 'muted', 'primary', 'secondary'])
  })

  it('drops a color value that smuggles CSS injection', () => {
    const { dark, warnings } = resolveTheme(
      stringify({ dark: { primary: 'red; } body { display:none }' } }),
      null,
    )
    expect(dark.primary).toBeUndefined()
    expect(warnings.some((w) => w.includes('primary'))).toBe(true)
  })

  it('drops a color token whose value is not color-shaped', () => {
    const { dark } = resolveTheme(stringify({ dark: { primary: '0.75rem' } }), null)
    expect(dark.primary).toBeUndefined()
  })

  it('validates radius as a length, rejecting a bare color', () => {
    expect(resolveTheme(stringify({ dark: { radius: '0.75rem' } }), null).dark.radius).toBe('0.75rem')
    expect(resolveTheme(stringify({ dark: { radius: '#fff' } }), null).dark.radius).toBeUndefined()
  })

  it('rejects a shadow value with injection but keeps an ordinary one', () => {
    expect(resolveTheme(stringify({ dark: { 'shadow-popover': '0 2px 8px #0006' } }), null).dark['shadow-popover']).toBe('0 2px 8px #0006')
    expect(resolveTheme(stringify({ dark: { 'shadow-popover': 'url(evil)' } }), null).dark['shadow-popover']).toBeUndefined()
  })
})

describe('resolveTheme — precedence (local over committed)', () => {
  it('deep-merges per key, local winning, within each mode', () => {
    const committed = stringify({
      dark: { primary: '#111', background: '#000' },
      light: { primary: '#eee' },
    })
    const local = stringify({ dark: { primary: '#f00' } })
    const { dark, light } = resolveTheme(committed, local)
    // local overrode only primary; background survives from committed
    expect(dark).toEqual({ primary: '#f00', background: '#000' })
    // light untouched by the local file
    expect(light).toEqual({ primary: '#eee' })
  })

  it('local-only works with no committed file', () => {
    const { dark } = resolveTheme(null, stringify({ dark: { primary: '#f00' } }))
    expect(dark).toEqual({ primary: '#f00' })
  })
})

describe('resolveTheme — fallback', () => {
  it('returns empty blocks when both files are absent', () => {
    expect(resolveTheme(null, null)).toEqual({ light: {}, dark: {}, warnings: [] })
  })

  it('falls back cleanly when a file is malformed JSON', () => {
    const { dark } = resolveTheme('{ broken', stringify({ dark: { primary: '#f00' } }))
    expect(dark).toEqual({ primary: '#f00' })
  })
})

describe('themeBlockToVars', () => {
  it('maps token slugs to their -- custom-property names', () => {
    expect(themeBlockToVars({ primary: '#f00', radius: '1rem', 'shadow-popover': '0 1px 2px #000' })).toEqual({
      '--primary': '#f00',
      '--radius': '1rem',
      '--shadow-popover': '0 1px 2px #000',
    })
  })
})

describe('THEME_TOKEN_GROUPS', () => {
  it('covers every whitelisted token exactly once', () => {
    // A token added to the whitelist and forgotten here is settable in the file
    // and invisible in the pane, which is the drift this guard exists for.
    const grouped = THEME_TOKEN_GROUPS.flatMap((g) => g.tokens)
    expect([...grouped].sort()).toEqual([...THEME_TOKENS].sort())
    expect(new Set(grouped).size).toBe(grouped.length)
  })

  it('gives every token a control kind the validator agrees with', () => {
    for (const slug of THEME_TOKENS) {
      expect(themeTokenKind(slug)).not.toBeNull()
    }
    expect(themeTokenKind('radius')).toBe('length')
    expect(themeTokenKind('shadow-popover')).toBe('shadow')
    expect(themeTokenKind('background')).toBe('color')
    expect(themeTokenKind('not-a-token')).toBeNull()
  })

  it('derives a label from the slug rather than restating it', () => {
    expect(themeTokenLabel('card-foreground')).toBe('Card foreground')
    expect(themeTokenLabel('background')).toBe('Background')
  })

  it('notes only tokens that actually exist', () => {
    for (const slug of Object.keys(THEME_TOKEN_NOTES)) {
      expect(THEME_TOKENS).toContain(slug)
    }
  })
})

describe('parseThemePatch', () => {
  it('takes a valid colour for one mode', () => {
    const { patch, warnings } = parseThemePatch(stringify({ dark: { primary: '#ff0000' } }))
    expect(patch).toEqual({ dark: { primary: '#ff0000' } })
    expect(warnings).toEqual([])
  })

  it('treats null as clear-it, which is how a reset reaches the file', () => {
    // Not an empty string: that would be dropped as invalid and leave the old
    // value in place, so the control would appear to do nothing.
    const { patch, warnings } = parseThemePatch(stringify({ light: { primary: null } }))
    expect(patch).toEqual({ light: { primary: null } })
    expect(warnings).toEqual([])
  })

  it('refuses a token outside the whitelist', () => {
    const { patch, warnings } = parseThemePatch(stringify({ dark: { position: 'absolute' } }))
    expect(patch).toEqual({})
    expect(warnings[0]).toMatch(/unknown token "position"/)
  })

  it('refuses a value the resolver would later drop', () => {
    // The pane must not be able to store something that reads back as nothing.
    const { patch, warnings } = parseThemePatch(
      stringify({ dark: { primary: 'url(http://x)', radius: '5 dogs' } }),
    )
    expect(patch).toEqual({})
    expect(warnings).toHaveLength(2)
  })

  it('is empty, not a throw, for nonsense', () => {
    expect(parseThemePatch('not json').patch).toEqual({})
    expect(parseThemePatch(null).patch).toEqual({})
    expect(parseThemePatch('').patch).toEqual({})
  })
})

describe('applyThemePatch', () => {
  const seeded = stringify({ $schema: 'holi-theme/v1', dark: {}, light: {} })

  it('sets a token in one mode and leaves the other alone', () => {
    const next = parse(applyThemePatch(seeded, { dark: { primary: '#ff0000' } }))
    expect(next.dark).toEqual({ primary: '#ff0000' })
    expect(next.light).toEqual({})
  })

  it('merges per key, keeping tokens the pane never touched', () => {
    // A vault's theme is as likely to have been written by hand or by the agent.
    const existing = stringify({ dark: { primary: '#111111', brand: '#222222' } })
    const next = parse(applyThemePatch(existing, { dark: { primary: '#ff0000' } }))
    expect(next.dark).toEqual({ primary: '#ff0000', brand: '#222222' })
  })

  it('deletes the key on null rather than writing an empty value', () => {
    const existing = stringify({ dark: { primary: '#111111', brand: '#222222' } })
    const next = parse(applyThemePatch(existing, { dark: { primary: null } }))
    expect(next.dark).toEqual({ brand: '#222222' })
    expect('primary' in next.dark).toBe(false)
  })

  it('keeps both blocks and the schema, even starting from nothing', () => {
    const next = parse(applyThemePatch(null, { light: { primary: '#ff0000' } }))
    expect(next.$schema).toBe('holi-theme/v1')
    expect(next.dark).toEqual({})
    expect(next.light).toEqual({ primary: '#ff0000' })
  })

  it('round-trips through resolveTheme, so the pane cannot write a dead value', () => {
    const written = applyThemePatch(seeded, { dark: { primary: '#ff0000', radius: '1rem' } })
    const resolved = resolveTheme(written, null)
    expect(resolved.dark).toEqual({ primary: '#ff0000', radius: '1rem' })
    expect(resolved.warnings).toEqual([])
  })

  it('ends with one newline, like every other file Holi writes', () => {
    expect(applyThemePatch(seeded, { dark: { primary: '#ff0000' } }).endsWith('}\n')).toBe(true)
  })
})
