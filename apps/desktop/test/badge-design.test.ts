import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = join(import.meta.dirname, '../src')
const badgeSource = readFileSync(join(sourceRoot, 'renderer/src/components/ui/badge.tsx'), 'utf8')
const themeSource = readFileSync(join(sourceRoot, 'renderer/src/index.css'), 'utf8')
const buttonSource = readFileSync(join(sourceRoot, 'renderer/src/components/ui/button.tsx'), 'utf8')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(entry.name) ? [path] : []
  })
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
      const background = variant
      const foreground =
        variant === 'destructive' ? 'destructive-solid-foreground' : 'badge-solid-foreground'
      expect(badgeSource).toContain(`${variant}: "bg-${background} text-${foreground}"`)
    }
    expect(themeSource).toContain('--badge-solid-foreground: var(--color-zinc-950)')
    expect(themeSource).toContain(
      '--color-destructive-solid-foreground: var(--destructive-solid-foreground)',
    )
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
    expect(calendar).toContain('invalid: "bg-destructive text-destructive-solid-foreground"')
    expect(calendar).toContain('invalidResize: "bg-destructive text-destructive-solid-foreground"')
    expect(calendar).not.toContain('border-destructive')
    expect(button).toContain(
      'bg-destructive text-destructive-solid-foreground hover:bg-destructive',
    )
    expect(button).not.toContain('bg-destructive/10 text-destructive')
  })

  it('keeps destructive button fill on the configurable Danger token', () => {
    expect(themeSource).toContain('--destructive: oklch(0.577 0.245 27.325)')
    expect(themeSource).toContain('--destructive: oklch(0.704 0.191 22.216)')
    expect(themeSource).toContain('--destructive-solid-foreground: oklch(0.985 0 0)')
    expect(themeSource).toContain('--destructive-solid-foreground: oklch(0.1 0 0)')
    expect(buttonSource).toContain('hover:bg-destructive')
  })
})
