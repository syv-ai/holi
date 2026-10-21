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

/** What the skills update a vault runs on open changed (`{remote, summary,
 * changed, conflicts}`), pushed once it is through. */
const onSkillsUpdated = pushChannel<unknown>('vault:skills')

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

/** Main asks for a vault path in a tab: a clicked reminder's task,
 * `holi docs open`, or a Holi link, which may name a heading to scroll to.
 * Carries `remote` so the renderer switches vaults first when the path lives
 * in another one, keeping `activeRemoteAtom` truthful (a main-side switch could
 * not). Main holds them until `openReady`. `focus: false` (`holi docs
 * screenshot`) opens it without moving the caret into it. */
const onOpen = pushChannel<{ remote: string; path: string; heading?: string; focus?: boolean }>(
  'vault:open',
)

/** Main's other question, for `holi docs screenshot`: where on the page a
 * path's tab is, once it has finished drawing. Answered with `located`, by
 * the request's id; main gives up after a few seconds. */
const onLocate = pushChannel<{ id: string; path: string }>('vault:locate')

/** Each plugin's events (`plugin:<id>`), one fan-out per plugin, made the
 *  first time that plugin is subscribed. */
const pluginChannels = new Map<string, ReturnType<typeof pushChannel<unknown>>>()
function onPlugin(id: string, cb: (event: unknown) => void): () => void {
  let channel = pluginChannels.get(id)
  if (channel === undefined) {
    channel = pushChannel<unknown>(`plugin:${id}`)
    pluginChannels.set(id, channel)
  }
  return channel(cb)
}

/** The Developer menu asked for the onboarding ritual, run against nothing.
 *  Dev builds only: main does not install the menu in a packaged app. */
const onTestOnboarding = pushChannel<void>('dev:test-onboarding')

/** A menu item ran: the id of a command in the renderer's table. ⌘W is the
 *  menu's accelerator, so the key never reaches the renderer as a keydown;
 *  this is how it arrives instead. */
const onMenuCommand = pushChannel<string>('menu:command')

/** Updating Holi itself: the updater's whole status, on every change. */
const onUpdateStatus = pushChannel<unknown>('updates:status')

/** A plugin's own window (`page-windows.ts`): what main tells its page. */
const onPageEvent = pushChannel<{ name: string; payload: unknown }>('page:event')

/** The ONE seam between renderer and main (architecture §3). */
contextBridge.exposeInMainWorld('holi', {
  trpc: (op: unknown) => ipcRenderer.invoke('holi:trpc', op),
  vault: {
    onSnapshot,
    onSyncState,
    onHeldBack,
    onCommitted,
    onSkillsUpdated,
    onFlushRequest,
    flushDone: () => ipcRenderer.send('vault:flush-done'),
    onOpen,
    openReady: () => ipcRenderer.send('vault:open-ready'),
    onLocate,
    located: (answer: unknown) => ipcRenderer.send('vault:located', answer),
  },
  /** Plugin events: main pushes `{remote, name, payload}` on `plugin:<id>`,
   *  and the renderer sends the same shape back, in order and unanswered. */
  plugin: {
    on: onPlugin,
    send: (id: string, event: { remote: string; name: string; payload: unknown }) =>
      ipcRenderer.send(`plugin:${id}`, event),
  },
  dev: {
    onTestOnboarding,
  },
  menu: {
    onCommand: onMenuCommand,
  },
  updates: {
    onStatus: onUpdateStatus,
  },
  /** A plugin's own window, such as the quick panel: one channel each way,
   *  heard by main only from the window that sent it. */
  page: {
    on: onPageEvent,
    send: (name: string, payload: unknown) => ipcRenderer.send('page:message', { name, payload }),
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
  showSaveDialog: (input: {
    remote: string
    path: string
    extension: string
    filterName: string
  }): Promise<string | null> => ipcRenderer.invoke('holi:showSaveDialog', input),
  /** Pick a folder on disk: the destination for Copy/Move to Folder…. */
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('holi:chooseFolder'),
})
