const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('holi', {
  trpc: (op) => ipcRenderer.invoke('qa:trpc', op),
  plugin: { send: (id, message) => ipcRenderer.send('qa:plugin', id, message) },
  on: () => () => {},
})
contextBridge.exposeInMainWorld('qaPlatform', {
  onEvent: (cb) => ipcRenderer.on('qa:event', (_e, event) => cb(event)),
})
