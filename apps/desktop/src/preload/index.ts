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
 * The whole vault, every time it changes: no per-path events.
 *
 * A snapshot cannot drift from the disk the way an event stream can: a dropped
 * filesystem event costs a delay rather than a permanently wrong tree, because
 * the vault's heal tick pushes the same shape on a timer.
 */
const onSnapshot = pushChannel<unknown>('vault:snapshot')

/** Up to date, pulling, offline (with a waiting count), no write access,
 * conflict, reconciling, or paused. Pushed on change only. */
const onSyncState = pushChannel<unknown>('vault:sync')

/** Files the large-file gate held out of the last commit (over the size cap).
 * Pushed every commit tick; empty clears the callout. */
const onHeldBack = pushChannel<unknown>('vault:heldback')

/** History moved: the paths a commit took, or null after a merged pull (any
 * file may have). The disk does not change on a commit, so no snapshot says so. */
const onCommitted = pushChannel<unknown>('vault:committed')

/**
 * The one thing main ASKS the renderer, rather than telling it.
 *
 * A commit commits what is on disk, so every durable moment is a flush then a
 * commit (`docs/glossary.md` §Flush). The renderer starts that itself everywhere
 * except quit, which only main knows is happening.
 *
 * Main gives up after a second, so `flushDone()` is a courtesy, not a lock: a
 * renderer that never answers delays a quit, it does not prevent one.
 */
const onFlushRequest = pushChannel<void>('vault:flush')

/** PTY bytes for an agent terminal's xterm to decode, and which terminal. */
const onAgentData = pushChannel<{ id: string; data: Uint8Array | string }>('agent-pty:data')
/** One terminal's client exited (a detach, or its session was stopped). */
const onAgentExit = pushChannel<{ id: string; code: number }>('agent-pty:exit')
/** The vault's live sessions, whenever the derived list changes. */
const onAgentSessions = pushChannel<unknown>('agent:sessions')
/** Holi's open terminals and their titles, whenever that changes. */
const onAgentTerminals = pushChannel<unknown>('agent:terminals')

/** A reminder fired and its notification was clicked: open this task, switching
 * vaults first if it lives in another one. Carries `remote` so the renderer's
 * switch keeps `activeRemoteAtom` truthful (a main-side switch could not). */
const onReminderOpen = pushChannel<{ remote: string; path: string }>('reminders:open')

/** The agent ran `holi app open <path>` and Holi should show that app.
 *  A push rather than a snapshot-derived effect on purpose: apps sync, so
 *  opening a tab whenever one *appears* would let a teammate's finished app
 *  decide what is on your screen. Only local authorship opens a tab. */
const onAppOpen = pushChannel<string>('apps:open')

/** The Developer menu asked for the onboarding ritual, run against nothing.
 *  Dev builds only: main does not install the menu in a packaged app. */
const onTestOnboarding = pushChannel<void>('dev:test-onboarding')

/** A menu item ran: the id of a command in the renderer's table. ⌘W is the
 *  menu's accelerator, so the key never reaches the renderer as a keydown;
 *  this is how it arrives instead. */
const onMenuCommand = pushChannel<string>('menu:command')

/** The ONE seam between renderer and main (architecture §3). */
contextBridge.exposeInMainWorld('holi', {
  trpc: (op: unknown) => ipcRenderer.invoke('holi:trpc', op),
  vault: {
    onSnapshot,
    onSyncState,
    onHeldBack,
    onCommitted,
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
  menu: {
    onCommand: onMenuCommand,
  },
  openExternal: (url: string) => ipcRenderer.invoke('holi:openExternal', url),
  openPath: (path: string) => ipcRenderer.invoke('holi:openPath', path),
  /**
   * The absolute path of a file dropped onto the window.
   *
   * `webUtils` answers only for a `File` the user actually dropped or picked,
   * so the renderer cannot invent one. It is synchronous, which matters,
   * because a `drop` handler cannot await before reading `dataTransfer`.
   */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** Hand these files to the OS as a drag. Fire-and-forget: a drag cannot wait
   *  for a round trip. */
  startDrag: (paths: string[]) => ipcRenderer.send('holi:startDrag', paths),
  showSaveDialog: (defaultName: string) => ipcRenderer.invoke('holi:showSaveDialog', defaultName),
  /** Pick a folder on disk: the destination for Copy/Move to Folder…. */
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('holi:chooseFolder'),
  agent: {
    onData: onAgentData,
    onExit: onAgentExit,
    onSessions: onAgentSessions,
    onTerminals: onAgentTerminals,
    sessions: () => ipcRenderer.invoke('agent:sessions'),
    terminals: () => ipcRenderer.invoke('agent:terminals'),
    open: (args: { attach?: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('agent:open', args),
    start: (args: { name?: string; prompt?: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('agent:start', args),
    send: (args: { text: string; target: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('agent:send', args),
    stop: (id: string) => ipcRenderer.invoke('agent:stop', id),
    respawn: (id: string) => ipcRenderer.invoke('agent:respawn', id),
    duplicate: (id: string, geometry: { cols?: number; rows?: number } = {}) =>
      ipcRenderer.invoke('agent:duplicate', { id, ...geometry }),
    attach: (terminalId: string): Promise<string> => ipcRenderer.invoke('agent:attach', terminalId),
    close: (terminalId: string) => ipcRenderer.invoke('agent-pty:close', terminalId),
    write: (id: string, data: string) => ipcRenderer.send('agent-pty:write', { id, data }),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send('agent-pty:resize', { id, cols, rows }),
    // No session: the focus file is the vault's, one path in the clone, read by
    // whichever session takes the next turn.
    setFocus: (focus: { focusedPath: string | null; openPaths: string[] }) =>
      ipcRenderer.send('agent:focus', focus),
  },
})
