import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = join(import.meta.dirname, '../src')
const badgeSource = readFileSync(join(sourceRoot, 'renderer/src/components/ui/badge.tsx'), 'utf8')
const themeSource = readFileSync(join(sourceRoot, 'renderer/src/index.css'), 'utf8')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const luminance = (rgb: readonly number[]) => {
    const [r, g, b] = rgb.map((channel) => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

describe('badge design contract', () => {
  it('exposes no tinted or outlined variants and never adds a border', () => {
    const deprecated = /(?:primary|success|warning|info|destructive|invert|focus)-(?:light|outline)/
    expect(badgeSource).not.toMatch(deprecated)
    expect(badgeSource).not.toMatch(/\boutline\s*:/)
    expect(badgeSource).not.toMatch(/\bborder(?:-[\w/.[\]%-]+)?\b/)

    for (const file of sourceFiles(sourceRoot)) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(deprecated)
      for (const [tag] of source.matchAll(/<Badge\b[^>]*>/g)) {
        expect(tag, file).not.toMatch(/\bvariant=(?:"|')outline(?:"|')/)
        expect(tag, file).not.toMatch(
          /className=(?:"[^"]*\bborder(?:-[^"]+)?|\{[^}]*\bborder(?:-[^}]+)?)/,
        )
        for (const hue of [
          'primary',
          'success',
          'warning',
          'info',
          'destructive',
          'focus',
          'invert',
        ]) {
          expect(tag, file).not.toMatch(new RegExp(`\\b(?:text|bg)-${hue}(?:-foreground)?\\b`))
        }
      }
    }
  })

  it('uses a neutral foreground for solid state badges', () => {
    for (const variant of ['info', 'success', 'warning', 'destructive', 'focus']) {
      const background = variant === 'destructive' ? 'status-destructive-solid' : variant
      expect(badgeSource).toContain(`${variant}: "bg-${background} text-badge-solid-foreground"`)
    }
    expect(themeSource).toContain('--badge-solid-foreground: var(--color-zinc-950)')
    expect(themeSource).toContain('--status-destructive-solid: var(--color-red-500)')
    expect(themeSource).toContain('--success: var(--color-emerald-500)')
    expect(themeSource).toContain('--warning: var(--color-yellow-500)')
    expect(themeSource).toContain('--info: var(--color-violet-500)')
    expect(themeSource).toContain('--focus: var(--color-blue-500)')
    expect(themeSource).toContain('--color-badge-solid-foreground: var(--badge-solid-foreground)')
    expect([...themeSource.matchAll(/--badge-solid-foreground:/g)]).toHaveLength(1)
  })

  it('keeps session, calendar, and destructive controls on the solid contract', () => {
    const session = readFileSync(
      join(sourceRoot, 'plugins/agent/renderer/sessions/session-card.tsx'),
      'utf8',
    )
    const calendar = readFileSync(
      join(sourceRoot, 'renderer/src/components/ui/event-calendar/event-calendar-event.tsx'),
      'utf8',
    )
    const button = readFileSync(join(sourceRoot, 'renderer/src/components/ui/button.tsx'), 'utf8')
    expect(session).toContain('<Badge variant="warning">')
    expect(calendar).toContain('invalid: "bg-status-destructive-solid text-badge-solid-foreground"')
    expect(calendar).not.toContain('border-destructive')
    expect(button).toContain('bg-status-destructive-solid text-badge-solid-foreground')
    expect(button).not.toContain('bg-destructive/10 text-destructive')
  })

  it('meets 4.5:1 for default status fills in light and dark themes', () => {
    // Tailwind v4 default 500 shades used by Holi's status tokens. Both themes
    // retain these fills; the destructive badge token is isolated from Alerts.
    const neutral = [9, 9, 11] as const // zinc-950
    const fills: Record<string, readonly number[]> = {
      success: [16, 185, 129], // emerald-500
      warning: [234, 179, 8], // yellow-500
      info: [139, 92, 246], // violet-500
      focus: [59, 130, 246], // blue-500
      destructive: [239, 68, 68], // red-500
    }
    for (const [name, fill] of Object.entries(fills)) {
      expect(contrastRatio(neutral, fill), `${name} light`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(neutral, fill), `${name} dark`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
