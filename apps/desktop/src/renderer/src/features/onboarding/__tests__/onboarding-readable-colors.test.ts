import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

const CSS = resolve(process.cwd(), 'src/renderer/src/features/onboarding/onboarding-ritual.css')
const css = await readFile(CSS, 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1]
  if (!body) throw new Error(`Missing onboarding rule ${selector}`)
  return body
}

function color(selector: string): string {
  return (
    rule(selector)
      .match(/\bcolor\s*:\s*([^;]+);/)?.[1]
      ?.trim() ?? ''
  )
}

test('readable naming and settings copy use full-opacity semantic colors', () => {
  expect(color(".onboarding-ritual .obrit-name-stage > [data-slot='input']::placeholder")).toBe(
    'var(--muted-foreground)',
  )
  expect(color('.onboarding-ritual .obrit-path-sep')).toBe('var(--muted-foreground)')
  expect(color('.onboarding-ritual .obrit-path .obrit-slug-out[data-default]')).toBe(
    'var(--muted-foreground)',
  )
  expect(color('.onboarding-ritual .obrit-path .obrit-slug-out')).toBe('var(--foreground)')
  expect(color('.onboarding-ritual .obrit-settings-where')).toBe('var(--muted-foreground)')
  for (const selector of [
    ".onboarding-ritual .obrit-name-stage > [data-slot='input']::placeholder",
    '.onboarding-ritual .obrit-path-sep',
    '.onboarding-ritual .obrit-path .obrit-slug-out[data-default]',
    '.onboarding-ritual .obrit-settings-where',
  ]) {
    expect(rule(selector)).not.toMatch(/color-mix\(in srgb, var\(--muted-foreground\)/)
  }
})

test('readable text has no faded parent in the settled active act', () => {
  expect(rule(".onboarding-ritual .obrit-act[data-state='active']")).toMatch(/opacity:\s*1;/)
  expect(rule('.onboarding-ritual .obrit-act-inner')).not.toMatch(/opacity\s*:/)
  expect(rule('.onboarding-ritual .obrit-path')).not.toMatch(/opacity\s*:/)
  expect(rule('.onboarding-ritual .obrit-settings-where')).not.toMatch(/opacity\s*:/)
  // Progress and transitioning acts intentionally retain their hidden/exiting opacity states.
  expect(rule('.onboarding-ritual .obrit-progress:not([data-shown])')).toMatch(/opacity:\s*0;/)
  expect(rule(".onboarding-ritual .obrit-act[data-state='exiting']")).toMatch(/opacity:\s*0;/)
})

test('the previous 80% muted helper on white fails WCAG AA', () => {
  const oldLightMuted = 0.54
  const linear = (channel: number) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  const linearMuted = oldLightMuted ** 3
  const foreground =
    linearMuted <= 0.0031308 ? 12.92 * linearMuted : 1.055 * linearMuted ** (1 / 2.4) - 0.055
  const mixed = foreground * 0.8 + 1 * 0.2
  const ratio = 1.05 / (linear(mixed) + 0.05)
  expect(ratio).toBeCloseTo(3.39, 2)
  expect(ratio).toBeLessThan(4.5)
})
