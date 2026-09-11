import { describe, expect, it } from 'vitest'
import {
  THEME_TOKENS,
  themeFromLegacy,
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

/**
 * A theme file, from the blocks it should hold.
 *
 * The fixtures are built rather than typed so every test here reads as "this
 * vault sets these tokens" — which is what they were asserting when the file
 * was YAML, and what they should keep asserting now that it is CSS.
 */
function css(
  theme: Record<'light' | 'dark', Record<string, string>> | Record<string, unknown>,
): string {
  return Object.entries(theme)
    .map(([mode, block]) => {
      const decls = Object.entries(block as Record<string, string>)
        .map(([slug, value]) => `  --${slug}: ${value};`)
        .join('\n')
      return `[data-theme='${mode}'] {\n${decls}\n}`
    })
    .join('\n\n')
}

describe('parseVaultTheme', () => {
  it('reads a declaration out of a recognised block', () => {
    expect(parseVaultTheme(css({ dark: { primary: '#3b82f6' } }))).toEqual({
      dark: { primary: '#3b82f6' },
    })
  })

  it('returns null on anything with no recognised block (never throws)', () => {
    expect(parseVaultTheme('{ not css')).toBeNull()
    expect(parseVaultTheme('')).toBeNull()
  })

  it('ignores a block whose selector it does not know', () => {
    // A parser, not a cascade: it has no business resolving specificity, so an
    // unrecognised selector is dropped rather than guessed at.
    expect(parseVaultTheme('body { --primary: #fff; }')).toBeNull()
    expect(parseVaultTheme('"a string"')).toBeNull()
    expect(parseVaultTheme('[1,2,3]')).toBeNull()
    expect(parseVaultTheme('null')).toBeNull()
    expect(parseVaultTheme('42')).toBeNull()
  })
})

describe('resolveTheme — whitelist', () => {
  it('keeps whitelisted color + chrome tokens', () => {
    const { dark } = resolveTheme(
      css({
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
      css({ dark: { primary: '#fff', width: '50px', notAToken: 'x' } }),
      null,
    )
    expect(dark).toEqual({ primary: '#fff' })
    expect(warnings.some((w) => w.includes('width'))).toBe(true)
    expect(warnings.some((w) => w.includes('notAToken'))).toBe(true)
  })

  it('has no layout tokens in the whitelist at all', () => {
    for (const banned of [
      'width',
      'height',
      'padding',
      'margin',
      'position',
      'top',
      'display',
      'gap',
    ]) {
      expect(THEME_TOKENS).not.toContain(banned)
    }
  })
})

describe('resolveTheme — validation', () => {
  it('keeps valid color forms (hex, rgb, hsl, oklch, named)', () => {
    const { dark } = resolveTheme(
      css({
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

  it('cannot smuggle a rule of its own past the whitelist', () => {
    // **CSS changes what this attempt even is.** In YAML the whole string was
    // one value and had to be REFUSED; here the `}` ends the block, so the
    // extra rule is not inside a value at all — it becomes a sibling rule with
    // an unrecognised selector, which the parser drops. What is left of the
    // declaration is an ordinary colour, and an ordinary colour is the most
    // this file has ever been allowed to say.
    //
    // The property being asserted is unchanged: nothing but whitelisted tokens
    // reaches the theme.
    const { dark } = resolveTheme(css({ dark: { primary: 'red; } body { display:none ' } }), null)
    expect(dark).toEqual({ primary: 'red' })
    expect(Object.keys(dark).every((k) => THEME_TOKENS.includes(k))).toBe(true)
  })

  it('still refuses a value that is unsafe on its own terms', () => {
    // The value-level gate is what CSS does NOT do for us: `url()` is perfectly
    // good CSS and must never be fetched from a theme a collaborator wrote.
    const { dark, warnings } = resolveTheme(
      css({ dark: { primary: 'url(https://example.com/x.png)' } }),
      null,
    )
    expect(dark.primary).toBeUndefined()
    expect(warnings.some((w) => w.includes('primary'))).toBe(true)
  })

  it('drops a color token whose value is not color-shaped', () => {
    const { dark } = resolveTheme(css({ dark: { primary: '0.75rem' } }), null)
    expect(dark.primary).toBeUndefined()
  })

  it('validates radius as a length, rejecting a bare color', () => {
    expect(resolveTheme(css({ dark: { radius: '0.75rem' } }), null).dark.radius).toBe('0.75rem')
    expect(resolveTheme(css({ dark: { radius: '#fff' } }), null).dark.radius).toBeUndefined()
  })

  it('rejects a shadow value with injection but keeps an ordinary one', () => {
    expect(
      resolveTheme(css({ dark: { 'shadow-popover': '0 2px 8px #0006' } }), null).dark[
        'shadow-popover'
      ],
    ).toBe('0 2px 8px #0006')
    expect(
      resolveTheme(css({ dark: { 'shadow-popover': 'url(evil)' } }), null).dark['shadow-popover'],
    ).toBeUndefined()
  })
})

describe('resolveTheme — precedence (local over committed)', () => {
  it('deep-merges per key, local winning, within each mode', () => {
    const committed = css({
      dark: { primary: '#111', background: '#000' },
      light: { primary: '#eee' },
    })
    const local = css({ dark: { primary: '#f00' } })
    const { dark, light } = resolveTheme(committed, local)
    // local overrode only primary; background survives from committed
    expect(dark).toEqual({ primary: '#f00', background: '#000' })
    // light untouched by the local file
    expect(light).toEqual({ primary: '#eee' })
  })

  it('local-only works with no committed file', () => {
    const { dark } = resolveTheme(null, css({ dark: { primary: '#f00' } }))
    expect(dark).toEqual({ primary: '#f00' })
  })
})

describe('resolveTheme — fallback', () => {
  it('returns empty blocks when both files are absent', () => {
    expect(resolveTheme(null, null)).toEqual({ light: {}, dark: {}, warnings: [] })
  })

  it('falls back cleanly when a file is malformed JSON', () => {
    const { dark } = resolveTheme('{ broken', css({ dark: { primary: '#f00' } }))
    expect(dark).toEqual({ primary: '#f00' })
  })
})

describe('themeBlockToVars', () => {
  it('maps token slugs to their -- custom-property names', () => {
    expect(
      themeBlockToVars({ primary: '#f00', radius: '1rem', 'shadow-popover': '0 1px 2px #000' }),
    ).toEqual({
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
  // **JSON, deliberately.** This reads the patch the renderer sends over IPC,
  // which has nothing to do with how the theme is stored — when the file became
  // CSS, pointing this at the file's parser would have made every write from
  // the settings pane parse as nothing.
  it('takes a valid colour for one mode', () => {
    const { patch, warnings } = parseThemePatch(JSON.stringify({ dark: { primary: '#ff0000' } }))
    expect(patch).toEqual({ dark: { primary: '#ff0000' } })
    expect(warnings).toEqual([])
  })

  it('treats null as clear-it, which is how a reset reaches the file', () => {
    // Not an empty string: that would be dropped as invalid and leave the old
    // value in place, so the control would appear to do nothing.
    const { patch, warnings } = parseThemePatch(JSON.stringify({ light: { primary: null } }))
    expect(patch).toEqual({ light: { primary: null } })
    expect(warnings).toEqual([])
  })

  it('refuses a token outside the whitelist', () => {
    const { patch, warnings } = parseThemePatch(JSON.stringify({ dark: { position: 'absolute' } }))
    expect(patch).toEqual({})
    expect(warnings[0]).toMatch(/unknown token "position"/)
  })

  it('refuses a value the resolver would later drop', () => {
    // The pane must not be able to store something that reads back as nothing.
    const { patch, warnings } = parseThemePatch(
      JSON.stringify({ dark: { primary: 'url(http://x)', radius: '5 dogs' } }),
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
  const seeded = applyThemePatch(null, {})

  /** What the file SAYS, read back through the parser that reads it for real. */
  const read = (text: string) => resolveTheme(text, null)

  it('sets a token in one mode and leaves the other alone', () => {
    const written = applyThemePatch(seeded, { dark: { primary: '#ff0000' } })
    expect(read(written).dark).toEqual({ primary: '#ff0000' })
    expect(read(written).light).toEqual({})
  })

  it('merges per key, keeping tokens the pane never touched', () => {
    // A vault's theme is as likely to have been written by hand or by the agent.
    const existing = css({ dark: { primary: '#111111', brand: '#222222' } })
    const written = applyThemePatch(existing, { dark: { primary: '#ff0000' } })
    expect(read(written).dark).toEqual({ primary: '#ff0000', brand: '#222222' })
  })

  it('deletes the key on null rather than writing an empty value', () => {
    const existing = css({ dark: { primary: '#111111', brand: '#222222' } })
    const written = applyThemePatch(existing, { dark: { primary: null } })
    expect(read(written).dark).toEqual({ brand: '#222222' })
  })

  it('writes both blocks, even starting from nothing', () => {
    const written = applyThemePatch(null, { light: { primary: '#ff0000' } })
    expect(written).toContain("[data-theme='dark'] {")
    expect(written).toContain("[data-theme='light'] {")
    expect(read(written).light).toEqual({ primary: '#ff0000' })
    expect(read(written).dark).toEqual({})
  })

  it('lists every token it did not set, so the file is the reference', () => {
    // The point of the shape: an empty file named none of forty tokens, so
    // knowing what you could write meant leaving the file.
    const written = applyThemePatch(null, { dark: { primary: '#ff0000' } })
    for (const slug of THEME_TOKENS) {
      expect(written, slug).toMatch(new RegExp(`^ {2}(/\\* )?--${slug}:`, 'm'))
    }
    expect(written).toContain('  --primary: #ff0000;')
    expect(written).toContain('  /* --brand: ; */')
  })

  it('brings a cleared token back as a commented-out declaration', () => {
    const set = applyThemePatch(null, { dark: { primary: '#ff0000' } })
    const cleared = applyThemePatch(set, { dark: { primary: null } })
    expect(cleared).toContain('  /* --primary: ; */')
    expect(read(cleared).dark).toEqual({})
  })

  it('keeps a declaration it does not recognise rather than deleting it', () => {
    // The resolver already warns about it. Silently dropping somebody's line
    // because we do not know the token is a worse answer than leaving it.
    const written = applyThemePatch(css({ dark: { 'not-a-token': '#ff0000' } }), {})
    expect(written).toContain('--not-a-token: #ff0000;')
  })

  it('never writes a comment marker inside a comment', () => {
    // The preamble once explained the markers USING the markers, which closed
    // the comment early and left the rest of the paragraph in the file as CSS.
    const body = seeded.slice(seeded.indexOf('*/') + 2)
    expect(body).not.toContain('/*/')
    expect(read(seeded)).toEqual({ dark: {}, light: {}, warnings: [] })
  })

  it('ends with one newline, like every other file Holi writes', () => {
    expect(seeded.endsWith('\n')).toBe(true)
    expect(seeded.endsWith('\n\n')).toBe(false)
  })
})
