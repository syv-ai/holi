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

/** The ONE seam between renderer and main (architecture §8). */
contextBridge.exposeInMainWorld('holi', {
  trpc: (op: unknown) => ipcRenderer.invoke('holi:trpc', op),
  auth: {
    get: () => ipcRenderer.invoke('holi:auth:get'),
    signIn: () => ipcRenderer.invoke('holi:auth:signIn'),
    devSignIn: (token: string) => ipcRenderer.invoke('holi:auth:devSignIn', token),
    signOut: () => ipcRenderer.invoke('holi:auth:signOut'),
  },
  collabAuth: () => ipcRenderer.invoke('holi:collab:auth'),
  vault: {
    activate: (vaultId: string) => ipcRenderer.invoke('holi:vault:activate', vaultId),
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
