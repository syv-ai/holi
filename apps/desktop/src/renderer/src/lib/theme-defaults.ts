/**
 * What Holi is actually painting, token by token, as values a theme file can
 * hold.
 *
 * `.holi/settings/theme.css` is written with the values in force, so what you
 * read is what you see.
 *
 * The browser resolves them: the defaults are `oklch()` and `color-mix()`, and
 * converting by hand means reimplementing colour spaces, while a generated
 * table would be a second copy of the palette that drifts. Asking the engine
 * cannot disagree with the screen.
 */
import { THEME_COLOR_TOKENS, THEME_LENGTH_TOKENS, THEME_SHADOW_TOKENS } from '@holi/shared'
import type { ThemeMode } from '@holi/shared'

/**
 * A painted colour, as a value the theme validator accepts.
 *
 * Alpha is kept: `--selection` is 30% opaque, and flattening it would paint
 * over the text it sits behind. The validator accepts `rgb(r g b / a)`.
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
 * Painted and read back, because nothing else converts: Chrome keeps computed
 * colours in their own space (`oklch(…)`, `color(srgb …)`), through
 * `getComputedStyle` and a `fillStyle` round trip alike. Rasterising one pixel
 * forces the conversion. jsdom returns `rgb(…)`, so tests cannot catch this.
 */
function paint(ctx: CanvasRenderingContext2D, value: string): string | null {
  ctx.clearRect(0, 0, 1, 1)
  // A refused value leaves the previous `fillStyle`, so reset it first.
  ctx.fillStyle = 'rgba(0, 0, 0, 0)'
  ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  return themeValueFromPixel(ctx.getImageData(0, 0, 1, 1).data)
}

/**
 * A colour no palette will hold, to catch a token that did not resolve: an
 * unresolved `var()` in `color` silently inherits the parent's colour rather
 * than reading empty.
 */
const UNRESOLVED = 'rgb(1, 2, 3)'

/**
 * Every themeable token's current value for one colour scheme, or `null` if any
 * of them could not be read.
 *
 * All or nothing: these values are written into a committed file, and while
 * the stylesheet is not in force (hot reload, cold start) every token falls
 * back to an inherited colour. A partial read is a wrong one.
 *
 * Read inside a `[data-theme]` subtree, so either mode can be read while the
 * app shows the other.
 *
 * The caller must clear any applied vault theme first: its inline properties
 * on the root would inherit through the probe for tokens the light block does
 * not re-declare. `useVaultTheme` clears, reads, then applies.
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
    // No 2D canvas (jsdom) means no conversion.
    if (ctx === null) return null
    const sentinel = paint(ctx, UNRESOLVED)
    for (const slug of THEME_COLOR_TOKENS) {
      probe.style.color = ''
      probe.style.color = `var(--${slug})`
      const computed = getComputedStyle(probe).color
      if (computed === '') return null
      const value = paint(ctx, computed)
      // The sentinel means the stylesheet is not in force: trust nothing.
      if (value === null || value === sentinel) return null
      out[slug] = value
    }
    // Lengths and shadows are literals: the property itself is the answer, and
    // empty means styles are not loaded.
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
