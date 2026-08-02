import { describe, expect, it } from 'vitest'
import {
  THEME_TOKENS,
  parseVaultTheme,
  resolveTheme,
  themeBlockToVars,
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
      JSON.stringify({
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
      JSON.stringify({ dark: { primary: '#fff', width: '50px', notAToken: 'x' } }),
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
      JSON.stringify({
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
      JSON.stringify({ dark: { primary: 'red; } body { display:none }' } }),
      null,
    )
    expect(dark.primary).toBeUndefined()
    expect(warnings.some((w) => w.includes('primary'))).toBe(true)
  })

  it('drops a color token whose value is not color-shaped', () => {
    const { dark } = resolveTheme(JSON.stringify({ dark: { primary: '0.75rem' } }), null)
    expect(dark.primary).toBeUndefined()
  })

  it('validates radius as a length, rejecting a bare color', () => {
    expect(resolveTheme(JSON.stringify({ dark: { radius: '0.75rem' } }), null).dark.radius).toBe('0.75rem')
    expect(resolveTheme(JSON.stringify({ dark: { radius: '#fff' } }), null).dark.radius).toBeUndefined()
  })

  it('rejects a shadow value with injection but keeps an ordinary one', () => {
    expect(resolveTheme(JSON.stringify({ dark: { 'shadow-popover': '0 2px 8px #0006' } }), null).dark['shadow-popover']).toBe('0 2px 8px #0006')
    expect(resolveTheme(JSON.stringify({ dark: { 'shadow-popover': 'url(evil)' } }), null).dark['shadow-popover']).toBeUndefined()
  })
})

describe('resolveTheme — precedence (local over committed)', () => {
  it('deep-merges per key, local winning, within each mode', () => {
    const committed = JSON.stringify({
      dark: { primary: '#111', background: '#000' },
      light: { primary: '#eee' },
    })
    const local = JSON.stringify({ dark: { primary: '#f00' } })
    const { dark, light } = resolveTheme(committed, local)
    // local overrode only primary; background survives from committed
    expect(dark).toEqual({ primary: '#f00', background: '#000' })
    // light untouched by the local file
    expect(light).toEqual({ primary: '#eee' })
  })

  it('local-only works with no committed file', () => {
    const { dark } = resolveTheme(null, JSON.stringify({ dark: { primary: '#f00' } }))
    expect(dark).toEqual({ primary: '#f00' })
  })
})

describe('resolveTheme — fallback', () => {
  it('returns empty blocks when both files are absent', () => {
    expect(resolveTheme(null, null)).toEqual({ light: {}, dark: {}, warnings: [] })
  })

  it('falls back cleanly when a file is malformed JSON', () => {
    const { dark } = resolveTheme('{ broken', JSON.stringify({ dark: { primary: '#f00' } }))
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
