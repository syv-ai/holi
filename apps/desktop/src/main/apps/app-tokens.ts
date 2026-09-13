/**
 * The palette an app starts from, before the vault's theme is laid over it.
 *
 * Without this, `appHeadHtml` injects only what `.holi/settings/theme.yaml` *overrides* —
 * and a vault with no theme (the common case; the seeded file is `{}`) gives an
 * app **no tokens at all**. Every `var(--foreground)` then resolves to nothing,
 * the browser falls back to black text on a transparent page, and the app is
 * unreadable. That is not a styling nicety: the seeded authoring skill tells
 * authors to use exactly these tokens, so the default has to be a real palette
 * rather than an empty block. (Found by hand, in the app — every unit test
 * passed with `:root{}`.)
 *
 * The values reproduce the renderer's dark defaults from `index.css`, with the
 * Tailwind palette references resolved to literals: `var(--color-neutral-950)`
 * means nothing inside an app frame, which has no Tailwind build. **`index.css`
 * is the source of truth** — if a default there changes, an app is off by a
 * shade until this is updated, which is cosmetic. What is NOT cosmetic is a
 * token going missing, so a test pins that every themeable token has a value.
 */
import { THEME_TOKENS, type ThemeBlock } from '@holi/shared'

export const APP_BASE_TOKENS: ThemeBlock = {
  background: 'oklch(14.5% 0 0)',
  foreground: 'oklch(97% 0 0)',
  card: 'oklch(20.5% 0 0)',
  'card-foreground': 'oklch(97% 0 0)',
  popover: 'oklch(20.5% 0 0)',
  'popover-foreground': 'oklch(97% 0 0)',
  primary: 'oklch(50% 0.134 242.749)',
  'primary-foreground': 'oklch(98.5% 0 0)',
  // sky-400, not sky-700: an app's links and figures are text on the dark
  // surface above, and `primary` is a fill colour. This is the one an app
  // should reach for when it wants the brand in a colour you can read.
  brand: 'oklch(74.6% 0.16 232.661)',
  secondary: 'oklch(26.9% 0 0)',
  'secondary-foreground': 'oklch(97% 0 0)',
  muted: 'oklch(26.9% 0 0)',
  'muted-foreground': 'oklch(70.8% 0 0)',
  accent: 'oklch(26.9% 0 0)',
  'accent-foreground': 'oklch(97% 0 0)',
  destructive: 'oklch(39.6% 0.141 25.723)',
  'destructive-foreground': 'oklch(93.6% 0.032 17.717)',
  border: 'oklch(26.9% 0 0)',
  // Derived, like `selection` below: a vault that recolours `border` or
  // `background` gets a divider that matches, without setting this.
  divider: 'color-mix(in srgb, var(--border) 55%, var(--background))',
  input: 'oklch(26.9% 0 0)',
  ring: 'oklch(50% 0.134 242.749)',
  'scrollbar-thumb': 'oklch(37.1% 0 0)',
  'scrollbar-thumb-hover': 'oklch(43.9% 0 0)',
  // Follows the brand, so a vault that recolours `primary` recolours this too.
  selection: 'color-mix(in srgb, var(--primary) 30%, transparent)',
  link: '#7dd3fc',
  'link-missing': '#f0abfc',
  task: '#fbbf24',
  'task-todo': '#6e7681',
  'task-doing': '#388bfd',
  'task-done': '#3fb950',
  radius: '0.5rem',
  'shadow-popover': '0 10px 24px -6px rgb(0 0 0 / 0.28), 0 4px 8px -4px rgb(0 0 0 / 0.2)',
  'shadow-dialog': '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
}

/** The tokens with no default here — empty, and the test keeps it that way. */
export function missingBaseTokens(): string[] {
  return THEME_TOKENS.filter((token) => !(token in APP_BASE_TOKENS))
}
