/**
 * What Holi is actually painting, token by token, as values a theme file can
 * hold.
 *
 * **Why this exists.** `.holi/settings/theme.css` is the vault's theme and the
 * settings tab is a window onto it — but a file whose every declaration is
 * commented out is not a source of truth, it is a list of things you could say.
 * The app was still reading its colours from `index.css`. This is what lets the
 * file answer the question it claims to: it gets written with the values in
 * force, so what you read is what you see.
 *
 * **The browser resolves them, not us.** Holi's defaults are `oklch()` into
 * Tailwind's palette and, for `--divider` and `--selection`, a `color-mix()` of
 * two other tokens. Converting either by hand means reimplementing colour
 * spaces — `css-color.ts` says so and refuses, and the alternative, snapshotting
 * `index.css` into a generated table, is a second copy of the palette that goes
 * quietly wrong the first time nobody reruns it. Asking the engine costs one
 * detached element and cannot disagree with what is on screen.
 */
import { THEME_COLOR_TOKENS, THEME_LENGTH_TOKENS, THEME_SHADOW_TOKENS } from '@holi/shared'
import type { ThemeMode } from '@holi/shared'

/**
 * A painted colour, as a value the theme validator accepts.
 *
 * **Alpha is kept, and it has to be.** `--selection` defaults to a `color-mix`
 * that is 30% opaque; flattening it to `#rrggbb` would write an opaque
 * selection into every vault and paint over the text it is meant to sit behind.
 * `rgb(r g b / a)` is in the validator's list of colour functions, so the
 * honest value is also a legal one.
 */
export function themeValueFromPixel(rgba: Uint8ClampedArray | number[]): string | null {
  if (rgba.length < 4) return null
  const [r, g, b, a] = rgba as unknown as [number, number, number, number]
  if (a === 0) return 'transparent'
  const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
  if (a === 255) return hex
  return `rgb(${r} ${g} ${b} / ${Math.round((a / 255) * 1000) / 1000})`
}

/**
 * A CSS colour as the sRGB bytes the screen actually gets.
 *
 * **Painted and read back, because nothing else converts.** Chrome keeps a
 * computed colour in its OWN space — `getComputedStyle` hands back
 * `oklch(0.145 0 0)` and `color(srgb 0.0998 …)`, and so does a canvas
 * `fillStyle` round trip. Both were tried in the running app; both preserve the
 * space. Rasterising a single pixel is the one thing that forces the engine to
 * do the conversion, out-of-gamut clamping included, and it round-trips a plain
 * hex unchanged.
 *
 * This is also the bug jsdom could never have caught: there, computed colours
 * come back as `rgb(…)`, so a naive number-scrape passes every test and writes
 * `#000000` for all forty tokens in the real app.
 */
function paint(ctx: CanvasRenderingContext2D, value: string): string | null {
  ctx.clearRect(0, 0, 1, 1)
  // A value the engine refuses leaves the previous `fillStyle` in place, so it
  // is reset to something known first: a refusal then reads as transparent
  // black rather than as whichever token happened to be read before it.
  ctx.fillStyle = 'rgba(0, 0, 0, 0)'
  ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  return themeValueFromPixel(ctx.getImageData(0, 0, 1, 1).data)
}

/**
 * Every themeable token's current value, for one colour scheme.
 *
 * **Read inside a `[data-theme]` subtree, so the other mode can be read too.**
 * `index.css` declares both schemes as attribute-scoped blocks, and a custom
 * property declared on an element beats one inherited from its parent — so a
 * probe carrying the attribute resolves that scheme's palette even while the app
 * is showing the other one.
 *
 * **The caller must clear any applied vault theme first.** Those land as inline
 * custom properties on `document.documentElement` and a token the light block
 * does not re-declare would inherit straight through this probe, recording the
 * vault's DARK override as light's default. `useVaultTheme` clears, reads, then
 * applies.
 */
/**
 * A colour no palette will ever hold, used to catch a token that did not
 * resolve.
 *
 * **An unresolved `var()` does not read as empty — it reads as a valid colour.**
 * `color: var(--nope)` is invalid at computed-value time, and `color` inherits,
 * so the probe quietly reports whatever its parent is. There is no error and no
 * blank to test for. Painting the parent an absurd colour turns that silent
 * fallback into a value we can recognise.
 */
const UNRESOLVED = 'rgb(1, 2, 3)'

/**
 * Every themeable token's current value for one colour scheme, or `null` if any
 * of them could not be read.
 *
 * **All or nothing, and that is the whole point of the return type.** These
 * values get written into a committed file. A moment when the stylesheet is not
 * in force — a hot reload swapping `index.css`, a cold start before styles
 * land — makes every token fall back to an inherited colour, and writing that
 * is how `--background: #380000` ended up committed to a real vault. A partial
 * read is not a smaller version of the answer; it is a wrong one.
 *
 * **Read inside a `[data-theme]` subtree, so the other mode can be read too.**
 * `index.css` declares both schemes as attribute-scoped blocks, and a custom
 * property declared on an element beats one inherited from its parent — so a
 * probe carrying the attribute resolves that scheme's palette even while the app
 * is showing the other one.
 *
 * **The caller must clear any applied vault theme first.** Those land as inline
 * custom properties on `document.documentElement`, and a token the light block
 * does not re-declare would inherit straight through this probe, recording the
 * vault's DARK override as light's value. `useVaultTheme` clears, reads, then
 * applies.
 */
export function resolveThemeDefaults(mode: ThemeMode): Record<string, string> | null {
  const scope = document.createElement('div')
  scope.setAttribute('data-theme', mode)
  scope.setAttribute('aria-hidden', 'true')
  scope.style.position = 'absolute'
  scope.style.visibility = 'hidden'
  scope.style.pointerEvents = 'none'
  // What an unresolved token will inherit, and nothing else.
  scope.style.color = UNRESOLVED

  const probe = document.createElement('span')
  scope.appendChild(probe)
  document.body.appendChild(scope)

  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  const out: Record<string, string> = {}
  try {
    // No 2D canvas — jsdom, notably — means no conversion, so there is nothing
    // honest to write.
    if (ctx === null) return null
    const sentinel = paint(ctx, UNRESOLVED)
    for (const slug of THEME_COLOR_TOKENS) {
      probe.style.color = ''
      probe.style.color = `var(--${slug})`
      const computed = getComputedStyle(probe).color
      if (computed === '') return null
      const value = paint(ctx, computed)
      // Equal to the sentinel means the `var()` fell through to the parent, so
      // the stylesheet is not in force and NOTHING here can be trusted.
      if (value === null || value === sentinel) return null
      out[slug] = value
    }
    // A length and a shadow are literals in `index.css`, so the custom property
    // itself is the answer — there is no colour to rasterise, and an empty one
    // is the same "styles are not loaded" signal.
    const scopeStyle = getComputedStyle(scope)
    for (const slug of [...THEME_LENGTH_TOKENS, ...THEME_SHADOW_TOKENS]) {
      const raw = scopeStyle.getPropertyValue(`--${slug}`).trim()
      if (raw === '') return null
      out[slug] = raw
    }
  } finally {
    scope.remove()
  }
  return out
}
