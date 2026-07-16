import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/** Push channels fan out from ONE ipcRenderer listener each: the panel
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

const onAgentData = pushChannel<string>('agent-pty:data')
const onAgentExit = pushChannel<{ code: number }>('agent-pty:exit')
const onAgentStatus = pushChannel<unknown>('agent:status')
/** The board's feed. Both ride the ONE SSE connection main owns — one per signed-in
 * user now, not per vault (D50). Main filters them to the active vault, so they stay
 * bare payloads with no envelope to unwrap. */
const onTasksEvent = pushChannel<unknown>('tasks:event')
const onTaskPresence = pushChannel<unknown>('tasks:presence')
/** The file tree's feed. Until now this frame reached main and fed only the on-disk
 * mirror — the renderer never saw it, which is why the tree went stale. */
const onDocsEvent = pushChannel<unknown>('docs:event')
/** You joined or left a vault. The one thing a per-vault stream could never tell you,
 * and the reason the switcher needed a restart (D51). */
const onVaultsEvent = pushChannel<unknown>('vaults:event')
/** The stream reconnected after a gap. There is no resume cursor on the wire, so
 * anything without a reconcile of its own has to refetch. */
const onStreamResync = pushChannel<unknown>('stream:resync')
/** A clicked reminder notification — main raises it, the renderer opens the task. */
const onReminderOpen = pushChannel<unknown>('reminders:open')
/** Collab (D59): main owns the Y.Doc and the relay connection; the renderer binds to it
 * over these. Payloads carry `docId` because push channels are unaddressed broadcasts —
 * the renderer filters. `update` is a Uint8Array: the first binary IPC in the app, which
 * structured clone carries intact. */
const onCollabUpdate = pushChannel<{ docId: string; update: Uint8Array }>('collab:update')
const onCollabAwareness = pushChannel<{ docId: string; update: Uint8Array }>('collab:awareness')
const onCollabStatus = pushChannel<{ docId: string; status: string }>('collab:status')

/** The ONE seam between renderer and main (architecture §8). */
contextBridge.exposeInMainWorld('holi', {
  trpc: (op: unknown) => ipcRenderer.invoke('holi:trpc', op),
  auth: {
    get: () => ipcRenderer.invoke('holi:auth:get'),
    signIn: () => ipcRenderer.invoke('holi:auth:signIn'),
    devSignIn: (token: string) => ipcRenderer.invoke('holi:auth:devSignIn', token),
    signOut: () => ipcRenderer.invoke('holi:auth:signOut'),
  },
  collab: {
    open: (docId: string): Promise<unknown> => ipcRenderer.invoke('holi:collab:open', docId),
    update: (docId: string, update: Uint8Array) =>
      ipcRenderer.invoke('holi:collab:update', { docId, update }),
    awareness: (docId: string, update: Uint8Array) =>
      ipcRenderer.invoke('holi:collab:awareness', { docId, update }),
    close: (docId: string) => ipcRenderer.invoke('holi:collab:close', docId),
    onUpdate: onCollabUpdate,
    onAwareness: onCollabAwareness,
    onStatus: onCollabStatus,
  },
  vault: {
    activate: (vaultId: string) => ipcRenderer.invoke('holi:vault:activate', vaultId),
  },
  vaults: {
    onEvent: onVaultsEvent,
  },
  docs: {
    onEvent: onDocsEvent,
  },
  stream: {
    onResync: onStreamResync,
  },
  reminders: {
    onOpen: onReminderOpen,
  },
  tasks: {
    onEvent: onTasksEvent,
    onPresence: onTaskPresence,
  },
  agent: {
    start: (args: { vaultId: string; resume?: boolean }) => ipcRenderer.invoke('agent-pty:start', args),
    write: (data: string) => ipcRenderer.invoke('agent-pty:write', data),
    resize: (cols: number, rows: number) => ipcRenderer.invoke('agent-pty:resize', { cols, rows }),
    kill: () => ipcRenderer.invoke('agent-pty:kill'),
    attach: () => ipcRenderer.invoke('agent-pty:attach'),
    status: () => ipcRenderer.invoke('holi:agent:status'),
    setFocus: (focus: { focusedPath: string | null; openPaths: string[] }) =>
      ipcRenderer.invoke('holi:agent:focus', focus),
    onData: onAgentData,
    onExit: onAgentExit,
    onStatus: onAgentStatus,
  },
  openExternal: (url: string) => ipcRenderer.invoke('holi:openExternal', url),
})
