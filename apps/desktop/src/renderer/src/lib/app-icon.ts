/**
 * Holi's app icon, drawn from the theme in force (docs/ui-system.md, Motion):
 * the "h" on a squircle of the window's own chrome colour, frosted like the
 * window's glass, with a glow of the theme's primary. The dock shows it, so a
 * light theme gets a light icon and a vault's own theme its own colours.
 *
 * `build/icon.svg` is the same drawing for the default dark theme, for the
 * packaged bundle and the dock before the window has drawn one.
 */
import { useEffect } from 'react'
import { BRAND_MONOGRAM } from '@/composites/BrandMark'

/** The macOS icon grid: a 1024 canvas, the squircle 824 inset by 100. */
export const ICON_SIZE = 1024
const INSET = 100
const SIDE = ICON_SIZE - INSET * 2
const RADIUS = 185

/** The colours the icon is drawn in, as CSS colours. */
export interface AppIconColors {
  /** The squircle: the window's chrome (`--sidebar`). */
  ground: string
  /** The "h" (`--foreground`). */
  ink: string
  /** The glow in the corner (`--primary`). */
  glow: string
  /** Whether the ground is dark: the frost and the depth are drawn for it. */
  dark: boolean
}

/** The theme's tokens, read off the document as they resolve now. */
export function themeIconColors(root: HTMLElement = document.documentElement): AppIconColors {
  const style = getComputedStyle(root)
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    ground: token('--sidebar', '#171717'),
    ink: token('--foreground', '#fafafa'),
    glow: token('--primary', '#e5e5e5'),
    dark: root.dataset.theme !== 'light',
  }
}

function squircle(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath()
  ctx.roundRect(INSET, INSET, SIDE, SIDE, RADIUS)
}

/** Draw the icon into a 1024 context. */
export function drawAppIcon(ctx: CanvasRenderingContext2D, colors: AppIconColors): void {
  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE)

  // The ground, with the soft drop shadow every macOS icon sits on.
  ctx.save()
  ctx.shadowColor = colors.dark ? 'rgba(0, 0, 0, 0.35)' : 'rgba(0, 0, 0, 0.18)'
  ctx.shadowBlur = 28
  ctx.shadowOffsetY = 12
  squircle(ctx)
  ctx.fillStyle = colors.ground
  ctx.fill()
  ctx.restore()

  ctx.save()
  squircle(ctx)
  ctx.clip()

  // The theme's primary, glowing up from the lower corner: what tints the
  // icon in a coloured theme, a faint light in the neutral one.
  const glow = ctx.createRadialGradient(830, 900, 0, 830, 900, 700)
  glow.addColorStop(0, colors.glow)
  glow.addColorStop(1, 'transparent')
  ctx.globalAlpha = colors.dark ? 0.22 : 0.3
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE)
  ctx.globalAlpha = 1

  // Frost: light falling from above, as on the window's glass.
  const frost = ctx.createLinearGradient(0, INSET, 0, INSET + SIDE)
  frost.addColorStop(0, colors.dark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.7)')
  frost.addColorStop(0.55, 'rgba(255, 255, 255, 0)')
  frost.addColorStop(1, colors.dark ? 'rgba(0, 0, 0, 0.22)' : 'rgba(0, 0, 0, 0.06)')
  ctx.fillStyle = frost
  ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE)

  // A sheen across the top left, where the light catches the glass.
  const sheen = ctx.createRadialGradient(300, 180, 0, 300, 180, 620)
  sheen.addColorStop(0, colors.dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.5)')
  sheen.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = sheen
  ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE)

  // The "h", 46% of the squircle tall, centred a touch above the middle so
  // it sits optically centred.
  const k = (SIDE * 0.46) / BRAND_MONOGRAM.height
  const w = BRAND_MONOGRAM.width * k
  const h = BRAND_MONOGRAM.height * k
  ctx.save()
  ctx.translate((ICON_SIZE - w) / 2, (ICON_SIZE - h) / 2 - SIDE * 0.01)
  ctx.scale(k, k)
  ctx.shadowColor = colors.dark ? 'rgba(0, 0, 0, 0.35)' : 'rgba(0, 0, 0, 0.12)'
  ctx.shadowBlur = 12 / k
  ctx.shadowOffsetY = 6 / k
  ctx.fillStyle = colors.ink
  for (const d of BRAND_MONOGRAM.paths) ctx.fill(new Path2D(d), BRAND_MONOGRAM.fillRule)
  ctx.restore()

  ctx.restore()

  // The rim: a hairline of light along the top edge, fading downwards.
  const rim = ctx.createLinearGradient(0, INSET, 0, INSET + SIDE)
  rim.addColorStop(0, colors.dark ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 255, 255, 0.9)')
  rim.addColorStop(0.5, colors.dark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.04)')
  rim.addColorStop(1, colors.dark ? 'rgba(255, 255, 255, 0)' : 'rgba(0, 0, 0, 0.1)')
  ctx.beginPath()
  ctx.roundRect(INSET + 1.5, INSET + 1.5, SIDE - 3, SIDE - 3, RADIUS - 1.5)
  ctx.strokeStyle = rim
  ctx.lineWidth = 3
  ctx.stroke()
}

/** How long the theme must settle before the icon is drawn again: a theme
 *  applies a few dozen tokens one `setProperty` at a time. */
const SETTLE_MS = 150

/**
 * Keep the dock's icon in the theme's colours, on macOS. Call once, from the
 * root. The theme reaches the page as the root's `data-theme` stamp
 * (`state/color-scheme.ts`) and its tokens as inline properties on the root
 * (`lib/theme-applicator.ts`), so watching the root's attributes sees every
 * change: light and dark, and a vault's own theme.
 */
export function useDockIcon(): void {
  useEffect(() => {
    const root = document.documentElement
    // Absent where there is no preload bridge (the tests' jsdom), and the
    // dock is macOS's.
    const send = window.holi?.setDockIcon
    if (!send || root.dataset.platform !== 'mac') return
    let last = ''
    let timer = 0
    const redraw = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const url = renderAppIcon(themeIconColors(root))
        if (url === null || url === last) return
        last = url
        send(url)
      }, SETTLE_MS)
    }
    const observer = new MutationObserver(redraw)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    redraw()
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [])
}

/** The icon as a PNG data URL, or null where there is no canvas to draw on. */
export function renderAppIcon(colors: AppIconColors): string | null {
  const canvas = document.createElement('canvas')
  canvas.width = ICON_SIZE
  canvas.height = ICON_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx || typeof ctx.roundRect !== 'function') return null
  drawAppIcon(ctx, colors)
  return canvas.toDataURL('image/png')
}
