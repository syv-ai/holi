import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CSS = resolve(process.cwd(), 'src/renderer/src/index.css')
const TAILWIND_THEME = resolve(process.cwd(), 'node_modules/tailwindcss/theme.css')
const SESSION_CARD = resolve(process.cwd(), 'src/plugins/agent/renderer/sessions/session-card.tsx')
const css = await readFile(CSS, 'utf8')
const tailwindTheme = await readFile(TAILWIND_THEME, 'utf8')
const sessionCard = await readFile(SESSION_CARD, 'utf8')

type RGB = [number, number, number]

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1]
  if (!block) throw new Error(`Missing CSS selector: ${selector}`)
  return block
}

function declarations(selector: string): Record<string, string> {
  const block = cssRule(selector)
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [
      name!,
      value!.trim(),
    ]),
  )
}

function oklch(color: string): RGB {
  const match = color.match(/oklch\(([\d.]+)%?\s+([\d.]+)\s+([\d.]+)/)
  if (!match) throw new Error(`Expected OKLCH, got ${color}`)
  const L = Number(match[1]!) / (color.includes('%') ? 100 : 1)
  const C = Number(match[2]!)
  const h = (Number(match[3]!) * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  const linear: RGB = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return linear.map(encode) as RGB
}

function encode(value: number): number {
  const clamped = Math.max(0, Math.min(1, value))
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
}

function decode(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function composite(foreground: RGB, background: RGB, alpha: number): RGB {
  return foreground.map((channel, i) => channel * alpha + background[i]! * (1 - alpha)) as RGB
}

function luminance([r, g, b]: RGB): number {
  return 0.2126 * decode(r) + 0.7152 * decode(g) + 0.0722 * decode(b)
}

function contrast(a: RGB, b: RGB): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter! + 0.05) / (darker! + 0.05)
}

function percentage(value: string): number {
  const match = value.match(/^([\d.]+)%$/)
  if (!match) throw new Error(`Expected CSS percentage, got ${value}`)
  return Number(match[1]!) / 100
}

function palette(name: string): string {
  const value = tailwindTheme.match(new RegExp(`${name}:\\s*(oklch\\([^;]+\\));`))?.[1]
  if (!value) throw new Error(`Missing Tailwind palette value: ${name}`)
  return value
}

function resolveColor(theme: Record<string, string>, name: string): string {
  const value = theme[name] ?? css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim()
  if (!value) throw new Error(`Missing theme color: ${name}`)
  return value.startsWith('var(--color-') ? palette(value.slice(4, -1)) : value
}

function token(selector: string, name: string): string {
  const value = declarations(selector)[name]
  if (!value) throw new Error(`Missing ${name} in ${selector}`)
  return value
}

const light = declarations(':root')
const dark = declarations("[data-theme='dark']")
const mac = declarations("[data-platform='mac']")
const darkMac = declarations("[data-platform='mac'][data-theme='dark']")
const clear = declarations("[data-platform='mac'][data-glass='clear']")
const solid = declarations("[data-platform='mac'][data-glass='solid']")
const darkSolid = declarations("[data-platform='mac'][data-theme='dark'][data-glass='solid']")
const drawerGlass = css.match(
  /\[data-platform='mac'\] \[data-drawer\]\[data-glass-ground\]:not\(main \*\) \{\s*--muted-foreground:\s*([^;]+);/,
)?.[1]
const darkDrawerGlass = css.match(
  /\[data-platform='mac'\]\[data-theme='dark'\] \[data-drawer\]\[data-glass-ground\]:not\(main \*\) \{\s*--muted-foreground:\s*([^;]+);/,
)?.[1]

describe('macOS glass text contrast from the production CSS cascade', () => {
  it('keeps solid status, destructive, default, secondary, and invert text readable', () => {
    const solidForeground = oklch(palette('--color-zinc-950'))
    for (const theme of [light, dark]) {
      for (const name of ['--success', '--info', '--warning', '--focus']) {
        expect(
          contrast(solidForeground, oklch(resolveColor(theme, name))),
          name,
        ).toBeGreaterThanOrEqual(4.5)
      }
      const destructiveForeground = oklch(theme['--destructive-solid-foreground']!)
      const destructiveFill = oklch(theme['--destructive']!)
      expect(
        contrast(destructiveForeground, destructiveFill),
        'destructive',
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrast(
          destructiveForeground,
          composite(destructiveFill, oklch(theme['--background']!), 1),
        ),
        'destructive hover',
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrast(oklch(theme['--secondary-foreground']!), oklch(theme['--secondary']!)),
        'secondary',
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrast(
          oklch(resolveColor(theme, '--invert-foreground')),
          oklch(resolveColor(theme, '--invert')),
        ),
        'invert',
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('uses calibrated encoded-sRGB compositing and WCAG luminance', () => {
    expect(contrast([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 10)
    expect(composite([0, 0, 0], [1, 1, 1], 0.5)).toEqual([0.5, 0.5, 0.5])
    expect(contrast(composite([0, 0, 0], [1, 1, 1], 0.5), [1, 1, 1])).toBeCloseTo(3.976653, 5)
    expect(composite(oklch('oklch(0.5 0 0)'), [1, 1, 1], 1)).toEqual([
      encode(0.125),
      encode(0.125),
      encode(0.125),
    ])
  })

  it('keeps startup defaults frosted and opaque outside macOS', () => {
    expect(mac['--glass-chrome']).toBe('90%')
    expect(mac['--glass-view']).toBe('95%')
    expect(token(':root', '--background')).toBe('oklch(1 0 0)')
    expect(css).toMatch(/\[data-platform='mac'\][\s\S]*?--glass-chrome:/)
    expect(declarations(':root')['--glass-chrome']).toBeUndefined()
  })

  it('keeps supporting theme surfaces opaque in both themes and Solid glass fully opaque', () => {
    for (const theme of [light, dark]) {
      for (const name of ['--background', '--card', '--popover', '--sidebar', '--accent']) {
        expect(theme[name], name).toMatch(/^oklch\([\d.]+\s+[\d.]+\s+[\d.]+\)$/)
      }
    }
    expect(solid['--glass-chrome']).toBe('100%')
    expect(solid['--glass-view']).toBe('100%')
    expect(darkSolid['--muted-foreground']).toBe('oklch(0.8 0 0)')
    expect(css).toMatch(
      /\[data-platform='mac'\] \[data-slot='sidebar'\],[\s\S]*?background: color-mix\(in oklab, var\(--sidebar\) var\(--glass-chrome\), transparent\);/,
    )
    expect(css).toMatch(
      /\[data-platform='mac'\] main:not\(\[data-glass-ground\] \*\),[\s\S]*?background: color-mix\(in oklab, var\(--background\) var\(--glass-view\), transparent\);/,
    )
  })

  const modes = ['Solid', 'Frosted', 'Clear'] as const
  const themes = ['light', 'dark'] as const
  const surfaces = ['chrome', 'main'] as const
  const backdrops = ['black', 'white'] as const

  for (const theme of themes) {
    for (const mode of modes) {
      for (const surface of surfaces) {
        it(`${theme} ${mode} ${surface} text clears AA over black and white`, () => {
          const darkTheme = theme === 'dark'
          const modeCss = mode === 'Clear' ? clear : mode === 'Solid' ? solid : {}
          const themeCss = darkTheme ? dark : light
          const glassTheme = darkTheme ? darkMac : mac
          const colorSelector = darkTheme && mode === 'Solid' ? darkSolid : undefined
          const ink = colorSelector
            ? token(
                "[data-platform='mac'][data-theme='dark'][data-glass='solid']",
                '--muted-foreground',
              )
            : mode === 'Solid'
              ? token("[data-platform='mac'][data-glass='solid']", '--muted-foreground')
              : glassTheme['--muted-foreground']
          if (!ink) throw new Error(`Missing muted foreground for ${theme}/${mode}`)
          const alphaName = surface === 'chrome' ? '--glass-chrome' : '--glass-view'
          const alphaValue = modeCss[alphaName] ?? mac[alphaName]
          if (!alphaValue) throw new Error(`Missing ${alphaName}`)
          const alpha = percentage(alphaValue)
          const surfaceColor = themeCss[surface === 'chrome' ? '--sidebar' : '--background']
          if (!surfaceColor) throw new Error(`Missing ${surface} color for ${theme}`)
          const foreground = oklch(ink)
          const ground = oklch(surfaceColor)
          const ratios = backdrops.map((backdrop) => {
            const compositedSurface = composite(
              ground,
              backdrop === 'black' ? [0, 0, 0] : [1, 1, 1],
              alpha,
            )
            return contrast(foreground, compositedSurface)
          })
          expect(
            Math.min(...ratios),
            `${theme}/${mode}/${surface}: ${ratios.join(', ')}`,
          ).toBeGreaterThanOrEqual(4.5)
        })
      }
    }
  }

  it('keeps selected session metadata at full foreground ink over its actual fills', () => {
    expect(sessionCard).toMatch(
      /current \? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'/,
    )
    const black: RGB = [0, 0, 0]
    const white: RGB = [1, 1, 1]
    const selectedCard = sessionCard.match(/current && 'bg-foreground\/10 hover:bg-foreground\/12'/)
    expect(selectedCard).not.toBeNull()
    const fillAlphas = [...selectedCard![0].matchAll(/bg-foreground\/(\d+)/g)].map(
      ([, alpha]) => Number(alpha) / 100,
    )
    expect(fillAlphas).toEqual([0.1, 0.12])
    for (const theme of [light, dark]) {
      const ink = oklch(theme['--foreground']!)
      const ground = oklch(theme['--sidebar']!)
      for (const glassAlpha of [1, 0.9, 0.82]) {
        for (const alpha of fillAlphas) {
          for (const backdrop of [black, white]) {
            const glassGround = composite(ground, backdrop, glassAlpha)
            const selectedGround = composite(oklch(theme['--foreground']!), glassGround, alpha)
            expect(contrast(ink, selectedGround)).toBeGreaterThanOrEqual(4.5)
          }
        }
      }
    }
  })

  it('keeps unselected session age and provider metadata at AA contrast over hover fills', () => {
    expect(
      sessionCard.match(
        /current \? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'/g,
      ),
    ).toHaveLength(2)
    expect(sessionCard).toContain("'group h-auto w-full")
    const hoverFill = sessionCard.match(/hover:bg-foreground\/(\d+)/)
    expect(hoverFill).not.toBeNull()
    const fillAlpha = Number(hoverFill![1]!) / 100
    const backdrops: RGB[] = [
      [0, 0, 0],
      [1, 1, 1],
    ]

    for (const theme of themes) {
      const darkTheme = theme === 'dark'
      const themeCss = darkTheme ? dark : light
      const glassTheme = darkTheme ? darkMac : mac
      const foreground = oklch(themeCss['--foreground']!)
      const sidebar = oklch(themeCss['--sidebar']!)

      for (const mode of modes) {
        const modeCss = mode === 'Clear' ? clear : mode === 'Solid' ? solid : {}
        const alpha = percentage(modeCss['--glass-chrome'] ?? mac['--glass-chrome']!)
        expect(glassTheme['--muted-foreground']).toBeDefined()
        for (const backdrop of backdrops) {
          const glassGround = composite(sidebar, backdrop, alpha)
          const hoveredGround = composite(foreground, glassGround, fillAlpha)
          expect(
            contrast(foreground, hoveredGround),
            `${theme}/${mode} over ${backdrop[0] === 0 ? 'black' : 'white'}`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('grounds the rendered Last turn drawer with the shared glass ground', () => {
    expect(css).toMatch(
      /\[data-platform='mac'\] \[data-drawer\]\[data-glass-ground\]:not\(main \*\) \{\s*background: color-mix\(in oklab, var\(--background\) var\(--glass-view\), transparent\);/,
    )
    expect(css).toMatch(
      /\[data-platform='mac'\] \[data-drawer\]\[data-glass-ground\] \{\s*background: transparent;/,
    )
    expect(drawerGlass).toBe('oklch(0.44 0 0)')
    expect(darkDrawerGlass).toBe('oklch(0.8 0 0)')
    expect(sessionCard).toContain(
      "current ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'",
    )
    const black: RGB = [0, 0, 0]
    const white: RGB = [1, 1, 1]
    for (const theme of [light, dark]) {
      const drawerInk = oklch(theme === dark ? darkDrawerGlass! : drawerGlass!)
      for (const alpha of [percentage(mac['--glass-view']!), percentage(clear['--glass-view']!)]) {
        for (const backdrop of [black, white]) {
          const ground = composite(oklch(theme['--background']!), backdrop, alpha)
          expect(contrast(drawerInk, ground)).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('proves the prior frosted, clear, and onboarding mixes are under AA', () => {
    const black: RGB = [0, 0, 0]
    const white: RGB = [1, 1, 1]
    const lightMuted = oklch('oklch(0.54 0 0)')
    const darkMuted = oklch('oklch(0.8 0 0)')
    const ratios = [
      contrast(lightMuted, composite(oklch('oklch(1 0 0)'), black, 0.8)),
      contrast(darkMuted, composite(oklch('oklch(0.985 0 0)'), white, 0.7)),
      contrast(darkMuted, composite(oklch('oklch(0.985 0 0)'), white, 0.25)),
      contrast(darkMuted, composite(oklch('oklch(1 0 0)'), white, 0)),

      contrast(composite(lightMuted, white, 0.8), white),
    ]
    expect(ratios[0]).toBeLessThan(4.5)
    expect(ratios[1]).toBeLessThan(4.5)
    expect(ratios[2]).toBeLessThan(4.5)
    expect(ratios[3]).toBeLessThan(4.5)
    expect(ratios[4]).toBeLessThan(4.5)
  })
})
