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
/** Every session of the open vault, whenever the derived list changes. */
const onAgentSessions = pushChannel<AgentSessionSummary[]>('agent:sessions')

/** Mirrors `SessionSummary` in main/agent/agent-manager.ts. */
interface AgentSessionSummary {
  id: string
  name: string
  state: 'needs-you' | 'working' | 'idle'
  waitingFor?: string
  configStale: boolean
  exited: boolean
}

/**
 * **The one-session adapter, and the whole of what D100's slice 1 costs the
 * renderer.**
 *
 * Main now speaks in session ids on every agent route. The drawer still shows
 * one session and calls `write(data)`, `kill()`, `attach()` with no address,
 * because the tab strip that would give it one is slice 2. So this remembers
 * which session the drawer is looking at — the one it started, or the first one
 * running when it reattaches after a reload — and addresses main's routes with
 * it. Slice 2 deletes every line of this and lets the renderer name its own tab.
 */
let currentSessionId: string | null = null

const listSessions = (): Promise<AgentSessionSummary[]> =>
  ipcRenderer.invoke('agent:sessions') as Promise<AgentSessionSummary[]>

const currentSession = async (): Promise<string | null> => {
  if (currentSessionId !== null) return currentSessionId
  // The first RUNNING one: main keeps an exited session in the list until it is
  // closed, and adopting a tombstone would replay a dead session's scrollback
  // and drop every keystroke while the live one ran unseen.
  currentSessionId = (await listSessions()).find((s) => !s.exited)?.id ?? null
  return currentSessionId
}

/** The list, folded back into the single status the drawer still renders.
 *  `working` is anything that is not idle: a session waiting on a permission
 *  prompt held the turn bracket open before the listing could say why. */
const foldStatus = (list: AgentSessionSummary[]) => ({
  running: list.some((s) => !s.exited),
  working: list.some((s) => !s.exited && s.state !== 'idle'),
  configStale: list.some((s) => !s.exited && s.configStale),
})

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
    onData: (cb: (data: Uint8Array | string) => void) =>
      onAgentData((p) => {
        if (currentSessionId === null || p.id === currentSessionId) cb(p.data)
      }),
    onExit: (cb: (e: { code: number }) => void) =>
      onAgentExit((p) => {
        if (currentSessionId === null || p.id === currentSessionId) cb({ code: p.code })
      }),
    onStatus: (cb: (status: ReturnType<typeof foldStatus>) => void) =>
      onAgentSessions((list) => cb(foldStatus(list))),
    attach: async (): Promise<string> => {
      const id = await currentSession()
      return id === null ? '' : ((await ipcRenderer.invoke('agent:attach', id)) as string)
    },
    status: async () => foldStatus(await listSessions()),
    start: async (args: {
      vaultId: string
      resume?: boolean
      cols?: number
      rows?: number
      prompt?: string
    }) => {
      const res = (await ipcRenderer.invoke('agent-pty:start', args)) as {
        ok: boolean
        id?: string
        message?: string
      }
      // The drawer's session from here on, including for the data tap's filter.
      if (res.ok && res.id !== undefined) currentSessionId = res.id
      return res
    },
    kill: async (): Promise<{ ok: true }> => {
      const id = await currentSession()
      currentSessionId = null
      if (id === null) return { ok: true }
      return (await ipcRenderer.invoke('agent-pty:kill', id)) as { ok: true }
    },
    // Synchronous on purpose: awaiting here would put two keystrokes on the
    // microtask queue and could land them out of order.
    write: (data: string) => {
      if (currentSessionId !== null)
        ipcRenderer.send('agent-pty:write', { id: currentSessionId, data })
    },
    resize: (cols: number, rows: number) => {
      if (currentSessionId !== null)
        ipcRenderer.send('agent-pty:resize', { id: currentSessionId, cols, rows })
    },
    setFocus: (focus: { focusedPath: string | null; openPaths: string[] }) =>
      ipcRenderer.send('agent:focus', focus),
  },
})
