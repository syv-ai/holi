import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('holi', {
  ping: (): Promise<string> => ipcRenderer.invoke('holi:ping'),
})
