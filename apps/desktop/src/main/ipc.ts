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
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import { callProcedure, toEnvelope, type TrpcEnvelope, type TrpcOp } from './trpc-call'

/**
 * The drag image. macOS refuses `startDrag` with an empty icon, and the file's
 * own icon is only available asynchronously — so this is a 1×1 transparent PNG
 * and the OS draws its own preview over it.
 */
const DRAG_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
)

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

  /**
   * Hand a vault file to the OS as a drag (`prd/notes-editor.md` FR-13).
   *
   * A web drag never tells the operating system a file is involved — it carries
   * MIME data, not a pasteboard file promise — so dropping a tree row into
   * Finder did nothing at all. `startDrag` is the only thing that can, and it
   * **replaces** the HTML drag rather than joining it: once this is called the
   * renderer stops receiving drag events, and the OS owns the gesture until the
   * user lets go. That is why the tree's own move now rides the same drag,
   * arriving back at the window as an ordinary file drop.
   *
   * `on`, not `handle`: this has to run while the mouse is still down, and a
   * round trip through a promise the renderer awaits is a round trip the drag
   * may not survive. The icon is prebuilt for the same reason — `getFileIcon`
   * is async, and a drag that has to wait for an icon is a drag that starts
   * late or not at all.
   */
  ipcMain.on('holi:startDrag', (event, paths: string[]) => {
    if (paths.length === 0) return
    event.sender.startDrag({ files: paths, file: paths[0]!, icon: DRAG_ICON })
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

  /**
   * Pick a folder on disk — where Copy to Folder… / Move to Folder… land
   * (FR-13). A folder rather than a save sheet because the same action serves a
   * single file, a multi-selection and a folder target, and the last two have
   * no single name to type. `createDirectory` so a destination can be made in
   * the sheet; tied to the calling window so it is a sheet, not a floating
   * dialog — the same shape as the save sheet above.
   */
  ipcMain.handle('holi:chooseFolder', async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = { properties: ['openDirectory' as const, 'createDirectory' as const] }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    // `filePaths[0]` is `string | undefined` under noUncheckedIndexedAccess.
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
}
