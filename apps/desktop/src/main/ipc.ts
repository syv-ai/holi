/**
 * The IPC surface, the ONLY seam between renderer and main
 * (`docs/architecture.md` §3): one request/response channel carrying the whole
 * tRPC router, plus the few native affordances only main can provide (system
 * browser, file manager, OS drag, native dialogs). Push channels out of main are
 * sent from `index.ts`.
 */
import type { AnyRouter } from '@trpc/server'
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
import { basename, dirname, join } from 'node:path'
import { vaultRelPath } from '@holi/shared'
import { callProcedure, toEnvelope, type TrpcEnvelope, type TrpcOp } from './trpc-call'

/**
 * The drag image. macOS refuses `startDrag` with an empty icon, and the file's
 * own icon is only available asynchronously — so this is a 1×1 transparent PNG
 * and the OS draws its own preview over it.
 */
const DRAG_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
)

export function registerIpc(deps: {
  router: AnyRouter
  /** A vault's clone on disk, or null when it is not known. */
  rootFor: (remote: string) => Promise<string | null>
}): void {
  ipcMain.handle('holi:trpc', (_event, op: TrpcOp): Promise<TrpcEnvelope> =>
    toEnvelope(callProcedure(deps.router, op)),
  )

  // The SYSTEM browser, not a window: the sign-in page has to reuse the user's
  // existing GitHub session, and no credential should ever enter the app's web
  // context.
  ipcMain.handle('holi:openExternal', async (_event, url: string) => {
    await shell.openExternal(url)
  })

  // The system FILE manager. `openExternal` is URL-only and will not reveal a
  // path on disk. It *reveals* (opens the parent with the item selected) so the
  // user sees the vault in place.
  ipcMain.handle('holi:openPath', (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  /**
   * Hand a vault file to the OS as a drag (`features/file-tree.md`).
   *
   * A web drag carries MIME data, not a file, so the OS never sees one.
   * `startDrag` **replaces** the HTML drag rather than joining it: the renderer
   * stops receiving drag events and the OS owns the gesture until release. That
   * is why the tree's own move rides the same drag, arriving back at the window
   * as an ordinary file drop.
   *
   * `on`, not `handle`: this has to run while the mouse is still down, and a
   * promise round trip is one the drag may not survive. The icon is prebuilt for
   * the same reason: `getFileIcon` is async.
   */
  ipcMain.on('holi:startDrag', (event, paths: string[]) => {
    if (paths.length === 0) return
    event.sender.startDrag({ files: paths, file: paths[0]!, icon: DRAG_ICON })
  })

  // The native SAVE sheet: the renderer names a vault file and the extension
  // to save as, and gets back an absolute path (or null on cancel) to hand to
  // whatever writes it. Tied to the calling window so it is a sheet, not a
  // floating dialog.
  //
  // It opens beside the vault file, named after it, so the output lands in the
  // vault unless the user picks somewhere else.
  ipcMain.handle(
    'holi:showSaveDialog',
    async (
      event,
      input: { remote: string; path: string; extension: string; filterName: string },
    ): Promise<string | null> => {
      if (!/^[a-z0-9]+$/i.test(input.extension)) {
        throw new Error(`not a file extension: ${input.extension}`)
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      const name = basename(input.path).replace(/\.[^.]+$/, '') + '.' + input.extension
      const root = await deps.rootFor(input.remote).catch(() => null)
      let dir = app.getPath('downloads')
      try {
        if (root !== null) dir = join(root, dirname(vaultRelPath(input.path)))
      } catch {
        // Not a vault path: Downloads.
      }
      const opts = {
        defaultPath: join(dir, name),
        filters: [{ name: input.filterName, extensions: [input.extension] }],
      }
      const result = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts)
      return result.canceled || result.filePath === undefined ? null : result.filePath
    },
  )

  /**
   * Pick a folder on disk, where Copy to Folder… / Move to Folder… land. A
   * folder rather than a save sheet because a multi-selection or a folder target
   * has no single name to type.
   */
  ipcMain.handle('holi:chooseFolder', async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = { properties: ['openDirectory' as const, 'createDirectory' as const] }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    // `filePaths[0]` is `string | undefined` under noUncheckedIndexedAccess.
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
}
