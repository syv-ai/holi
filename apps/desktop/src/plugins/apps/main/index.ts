/**
 * Vault apps' main side (docs/features/vault-apps.md): the `holi-app:` scheme
 * that serves each app from its own bundle, the app door with this machine's
 * approvals of apps' Google reads, and the `apps.*` and `store.*`
 * capabilities. It seeds the vault-apps skill and the check hook.
 *
 * What a synced vault holds of an app stays core whatever this machine runs:
 * the record merge driver, the `.local.app` never-commit rule and the `data/`
 * fences.
 */
import { join } from 'node:path'
import type { AppDoor, MainPlugin } from '../../../main/plugin-api'
import type { PreviewRect } from './capabilities'
import { APPS_INFO } from '../info'
import { appsCapabilities, storeCapabilities } from './capabilities'
import { envCapabilities, ENV_NAMESPACES } from './env'
import { admitApps, createAppGrants } from './grants'
import { createAppPreviews } from './previews'
import { appScheme } from './protocol'
import { appsSeed } from './seed'

/** The widest a preview is kept: a card's plate at twice its size. */
const PREVIEW_WIDTH = 720

/**
 * The window's pixels inside an app's frame, as a small JPEG. The frame is
 * an iframe in Holi's own page, so its picture is the window's, cut to the
 * frame's rect; the renderer measures the rect in CSS pixels, scaled here by
 * the page's zoom. A hidden or minimised window gives an empty image, which
 * is no preview.
 */
async function capture(rect: PreviewRect): Promise<Buffer | null> {
  const { BrowserWindow } = await import('electron')
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible())
  if (win === undefined || win.isMinimized()) return null
  const zoom = win.webContents.getZoomFactor()
  const image = await win.webContents.capturePage({
    x: Math.round(rect.x * zoom),
    y: Math.round(rect.y * zoom),
    width: Math.round(rect.width * zoom),
    height: Math.round(rect.height * zoom),
  })
  if (image.isEmpty()) return null
  const { width } = image.getSize()
  const small =
    width > PREVIEW_WIDTH ? image.resize({ width: PREVIEW_WIDTH, quality: 'good' }) : image
  return small.toJPEG(80)
}

export const appsMain: MainPlugin = {
  info: APPS_INFO,
  seed: appsSeed,
  schemes: [appScheme],
  activate(ctx) {
    // Kept in main, never the renderer, which is the process running the
    // apps' code.
    const grants = createAppGrants(join(ctx.userData, 'app-grants.json'))
    // The app door's one opener: the approvals an entry's `appGrant` asks for.
    const door: AppDoor = ctx.openAppDoor({ admit: admitApps(grants) })
    const previews = createAppPreviews(join(ctx.userData, 'app-previews'))
    ctx.register(
      ['apps'],
      appsCapabilities({ events: ctx, appDoor: () => door, grants, previews, capture }),
    )
    ctx.register(['store'], storeCapabilities())
    ctx.register(ENV_NAMESPACES, envCapabilities())
    // The renderer may have asked for the slash commands before they were
    // registered: tell it they answer now.
    ctx.emit(ctx.remote, 'commands-changed', null)
    return () => {}
  },
}
