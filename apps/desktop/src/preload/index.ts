import { contextBridge, ipcRenderer } from 'electron'

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
  openExternal: (url: string) => ipcRenderer.invoke('holi:openExternal', url),
})
