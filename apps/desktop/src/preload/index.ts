import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

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

/** Files the large-file gate held out of the last commit (over the size cap).
 * Pushed every commit tick; empty clears the callout. */
const onHeldBack = pushChannel<unknown>('vault:heldback')

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

/** PTY bytes for the drawer's xterm to decode, and which session produced them. */
const onAgentData = pushChannel<{ id: string; data: Uint8Array | string }>('agent-pty:data')
/** One session ended. */
const onAgentExit = pushChannel<{ id: string; code: number }>('agent-pty:exit')
/** Every session of the open vault, whenever the derived list changes. One
 *  channel for the whole set: a tab strip renders the list, not a diff of it. */
const onAgentSessions = pushChannel<unknown>('agent:sessions')

/** A reminder fired and its notification was clicked — open this task, switching
 * vaults first if it lives in another one. Carries `remote` so the renderer's
 * switch keeps `activeRemoteAtom` truthful (a main-side switch could not). */
const onReminderOpen = pushChannel<{ remote: string; path: string }>('reminders:open')

/** The agent ran `holi app open <id>` and Holi should show that app.
 *  A push rather than a snapshot-derived effect on purpose: apps sync, so
 *  opening a tab whenever one *appears* would let a teammate's finished app
 *  decide what is on your screen. Only local authorship opens a tab. */
const onAppOpen = pushChannel<string>('apps:open')

/** The Developer menu asked for the onboarding ritual, run against nothing.
 *  Dev builds only — main does not install the menu in a packaged app, so this
 *  channel simply never fires there. */
const onTestOnboarding = pushChannel<void>('dev:test-onboarding')

/** The ONE seam between renderer and main (architecture §8). */
contextBridge.exposeInMainWorld('holi', {
  trpc: (op: unknown) => ipcRenderer.invoke('holi:trpc', op),
  vault: {
    onSnapshot,
    onSyncState,
    onHeldBack,
    onFlushRequest,
    flushDone: () => ipcRenderer.send('vault:flush-done'),
  },
  reminders: {
    onOpen: onReminderOpen,
  },
  apps: {
    onOpen: onAppOpen,
  },
  dev: {
    onTestOnboarding,
  },
  openExternal: (url: string) => ipcRenderer.invoke('holi:openExternal', url),
  openPath: (path: string) => ipcRenderer.invoke('holi:openPath', path),
  /**
   * The absolute path of a file dropped onto the window.
   *
   * `File.path` used to carry it and no longer exists — Electron moved it here
   * precisely so the renderer cannot invent one: `webUtils` answers only for a
   * `File` the user actually dropped or picked. It is synchronous, which
   * matters, because a `drop` handler cannot await before reading
   * `dataTransfer`.
   */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** Hand these files to the OS as a drag. Fire-and-forget: a drag cannot wait
   *  for a round trip. */
  startDrag: (paths: string[]) => ipcRenderer.send('holi:startDrag', paths),
  showSaveDialog: (defaultName: string) => ipcRenderer.invoke('holi:showSaveDialog', defaultName),
  /** Pick a folder on disk — the destination for Copy/Move to Folder… (FR-13). */
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('holi:chooseFolder'),
  agent: {
    onData: onAgentData,
    onExit: onAgentExit,
    onSessions: onAgentSessions,
    sessions: () => ipcRenderer.invoke('agent:sessions'),
    attach: (id: string): Promise<string> => ipcRenderer.invoke('agent:attach', id),
    start: (args: {
      vaultId: string
      name?: string
      resume?: boolean
      cols?: number
      rows?: number
      prompt?: string
      paste?: string
    }) => ipcRenderer.invoke('agent-pty:start', args),
    paste: (id: string, text: string) => ipcRenderer.invoke('agent:paste', { id, text }),
    duplicate: (id: string) => ipcRenderer.invoke('agent:duplicate', id),
    kill: (id: string) => ipcRenderer.invoke('agent-pty:kill', id),
    write: (id: string, data: string) => ipcRenderer.send('agent-pty:write', { id, data }),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send('agent-pty:resize', { id, cols, rows }),
    // No session: the focus file is the vault's, one path in the clone, read by
    // whichever session takes the next turn.
    setFocus: (focus: { focusedPath: string | null; openPaths: string[] }) =>
      ipcRenderer.send('agent:focus', focus),
  },
})
