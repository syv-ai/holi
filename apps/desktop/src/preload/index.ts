import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/** Push channels fan out from ONE ipcRenderer listener each: a component
 * subscribes and unsubscribes across remounts, and per-subscriber listeners
 * would leak into Electron's max-listeners warning. */
function pushChannel<T>(channel: string) {
  const subscribers = new Set<(payload: T) => void>()
  ipcRenderer.on(channel, (_e: IpcRendererEvent, payload: T) => {
    for (const cb of subscribers) cb(payload)
  })
  return (cb: (payload: T) => void) => {
    subscribers.add(cb)
    return () => void subscribers.delete(cb)
  }
}

/**
 * The whole vault, every time it changes — no per-path events.
 *
 * `scanVault` is a walk and a parse, so re-deriving is cheap and a snapshot
 * cannot drift from the disk the way an event stream can. It also means a
 * dropped filesystem event costs a delay rather than a permanently wrong tree,
 * because the vault's heal tick pushes the same shape on a timer.
 */
const onSnapshot = pushChannel<unknown>('vault:snapshot')

/** Up to date, pulling, offline (with a waiting count), no write access,
 * conflict, reconciling, or paused. Pushed on change only. */
const onSyncState = pushChannel<unknown>('vault:sync')

/**
 * The one thing main ASKS the renderer, rather than telling it.
 *
 * A commit commits what is on disk, and the editor's newest words are in a
 * buffer until it writes them — so every durable moment is a flush then a
 * commit (`docs/glossary.md` §Flush). The renderer starts that sequence itself
 * for ⌘S, publish, tab close, vault switch and blur; quit is the one main
 * starts, because only main knows it is happening.
 *
 * Main gives up after a second, so `flushDone()` is a courtesy, not a lock: a
 * renderer that never answers delays a quit, it does not prevent one.
 */
const onFlushRequest = pushChannel<void>('vault:flush')

/** The ONE seam between renderer and main (architecture §8). */
contextBridge.exposeInMainWorld('holi', {
  trpc: (op: unknown) => ipcRenderer.invoke('holi:trpc', op),
  vault: {
    onSnapshot,
    onSyncState,
    onFlushRequest,
    flushDone: () => ipcRenderer.send('vault:flush-done'),
  },
  openExternal: (url: string) => ipcRenderer.invoke('holi:openExternal', url),
  openPath: (path: string) => ipcRenderer.invoke('holi:openPath', path),
  showSaveDialog: (defaultName: string) => ipcRenderer.invoke('holi:showSaveDialog', defaultName),
})
