/**
 * The IPC surface — the ONLY seam between renderer and main (architecture §8).
 *
 * Three things live on it, deliberately: one request/response channel carrying
 * the whole tRPC router, one escape hatch for opening a URL in the system
 * browser, and — registered by `index.ts` rather than here — two push channels
 * out of the active vault.
 *
 * Everything the previous version carried is gone: `collab:*`, `docs:event`,
 * `tasks:event`, `tasks:presence`, `vaults:event`, `stream:resync` and
 * `reminders:open` all rode an SSE connection to a server that no longer
 * exists, and `holi:auth:*` moved into the router when GitHub became identity.
 */
import type { AnyRouter } from '@trpc/server'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { callProcedure, toEnvelope, type TrpcEnvelope, type TrpcOp } from './trpc-call'

export function registerIpc(deps: { router: AnyRouter }): void {
  ipcMain.handle(
    'holi:trpc',
    (_event, op: TrpcOp): Promise<TrpcEnvelope> => toEnvelope(callProcedure(deps.router, op)),
  )

  // The SYSTEM browser, not a window. FR-2's device-flow page has to reuse the
  // user's existing GitHub session, and no credential should ever enter the
  // app's web context; FR-11 deep-links to collaborator settings because Holi
  // does not implement invitation.
  ipcMain.handle('holi:openExternal', async (_event, url: string) => {
    await shell.openExternal(url)
  })

  // The system FILE manager, not the browser. `openExternal` is URL-only and
  // will not reveal a path on disk; this is its sibling for a vault's local
  // clone (FR-15). It *reveals* — opens the parent with the folder selected —
  // rather than opening the folder itself, so the user sees the vault in place.
  ipcMain.handle('holi:openPath', (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  // The native SAVE sheet for Convert-to-PDF (slice 2). Only main can present a
  // native dialog, so the renderer asks here, gets back an absolute path (or
  // null on cancel), and hands it to `pdf.render`. Defaults to the note's name
  // under Downloads; tied to the calling window so it is a sheet, not a floating
  // dialog.
  ipcMain.handle(
    'holi:showSaveDialog',
    async (event, defaultName: string): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        defaultPath: join(app.getPath('downloads'), defaultName),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      }
      const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      return result.canceled || result.filePath === undefined ? null : result.filePath
    },
  )
}
