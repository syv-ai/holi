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

/** PTY bytes for the drawer's xterm to decode. */
const onAgentData = pushChannel<Uint8Array | string>('agent-pty:data')
/** The session ended. */
const onAgentExit = pushChannel<{ code: number }>('agent-pty:exit')
/** running / working / configStale / authenticated — the header dot + hints. */
const onAgentStatus = pushChannel<unknown>('agent:status')

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
  agent: {
    onData: onAgentData,
    onExit: onAgentExit,
    onStatus: onAgentStatus,
    attach: (): Promise<string> => ipcRenderer.invoke('agent:attach'),
    status: () => ipcRenderer.invoke('agent:status'),
    start: (args: { vaultId: string; resume?: boolean; cols?: number; rows?: number; prompt?: string }) =>
      ipcRenderer.invoke('agent-pty:start', args),
    kill: () => ipcRenderer.invoke('agent-pty:kill'),
    write: (data: string) => ipcRenderer.send('agent-pty:write', data),
    resize: (cols: number, rows: number) => ipcRenderer.send('agent-pty:resize', { cols, rows }),
    setFocus: (focus: { focusedPath: string | null; openPaths: string[] }) =>
      ipcRenderer.send('agent:focus', focus),
  },
})
