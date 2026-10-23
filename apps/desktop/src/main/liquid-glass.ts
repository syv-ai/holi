/**
 * macOS 26's liquid glass behind the main window: the system's own
 * `NSGlassEffectView` (electron-liquid-glass), inserted behind the page rather
 * than a CSS imitation. It needs a transparent window and no `vibrancy`, which
 * would draw over it, so `wantsLiquidGlass` decides the window's options before
 * it is created and `applyLiquidGlass` adds the view once the page has loaded.
 *
 * Loaded lazily, like node-pty: a native module that fails to load (an older
 * macOS, a missing prebuild) costs the glass, never the window, which falls
 * back to the vibrancy it had before.
 */
import type { BrowserWindow } from 'electron'

type LiquidGlass = {
  isGlassSupported(): boolean
  addView(handle: Buffer, options?: { cornerRadius?: number; tintColor?: string; opaque?: boolean }): number
}

let loaded: LiquidGlass | null | undefined

function liquidGlass(): LiquidGlass | null {
  if (loaded !== undefined) return loaded
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('electron-liquid-glass') as { default?: LiquidGlass } & LiquidGlass
    loaded = mod.default ?? mod
  } catch (error) {
    console.warn('[liquid-glass] unavailable, keeping vibrancy:', error)
    loaded = null
  }
  return loaded
}

/** True on a macOS that has liquid glass and a module that loads. */
export function wantsLiquidGlass(): boolean {
  if (process.platform !== 'darwin') return false
  if (Number(process.getSystemVersion().split('.')[0]) < 26) return false
  return liquidGlass()?.isGlassSupported() === true
}

/** Put the glass behind `win`'s page; once, after its first load. */
export function applyLiquidGlass(win: BrowserWindow): void {
  const glass = liquidGlass()
  if (!glass) return
  win.webContents.once('did-finish-load', () => {
    try {
      glass.addView(win.getNativeWindowHandle())
    } catch (error) {
      console.warn('[liquid-glass] addView failed:', error)
      win.setVibrancy('under-window')
    }
  })
}
