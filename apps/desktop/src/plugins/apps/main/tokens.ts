/**
 * The palette an app starts from, before the vault's theme is laid over it.
 *
 * Without a base, `appHeadHtml` injects only what the vault's theme files set,
 * and a token they leave out resolves to nothing in the app: every
 * `var(--foreground)` is empty and the app is unreadable. The base is Holi's
 * own theme file for the mode, the one a vault is seeded with, so there is no
 * second copy of it here.
 *
 * **An app frame has no Tailwind build**, and Holi's theme is written on
 * Tailwind's palette (`var(--color-sky-700)`). So the head also declares every
 * palette colour the block refers to, read from Tailwind's own `theme.css`.
 */
import { THEME_TOKENS, type ThemeBlock, type ThemeMode } from '@holi/shared'
import TAILWIND_THEME from 'tailwindcss/theme.css?raw'
import { holiTheme } from '../../../main/plugin-api'

/** Tailwind's palette, `color-sky-700` to its value. Colours only. */
const PALETTE: ReadonlyMap<string, string> = new Map(
  [...TAILWIND_THEME.matchAll(/--(color-[a-z]+(?:-\d{2,3})?)\s*:\s*([^;]+);/g)].map((m) => [
    m[1]!,
    m[2]!.trim(),
  ]),
)

/** Holi's own theme for `mode`: every themeable token. */
export function appBaseTokens(mode: ThemeMode): ThemeBlock {
  return holiTheme()[mode]
}

/** The tokens with no base value in `mode`: empty, and the test keeps it that way. */
export function missingBaseTokens(mode: ThemeMode): string[] {
  const base = appBaseTokens(mode)
  return THEME_TOKENS.filter((token) => !(token in base))
}

/** The palette colours `block`'s values refer to, as a block of their own. */
export function paletteFor(block: ThemeBlock): ThemeBlock {
  const out: ThemeBlock = {}
  for (const value of Object.values(block)) {
    for (const [, name] of value.matchAll(/var\(\s*--(color-[a-z0-9-]+)\s*\)/g)) {
      const colour = PALETTE.get(name!)
      if (colour !== undefined) out[name!] = colour
    }
  }
  return out
}
