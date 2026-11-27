import '../src/preload'
import { ipcRenderer } from 'electron'

ipcRenderer.send('holi-550:preload', {
  sandboxed: process.sandboxed,
  contextIsolated: process.contextIsolated,
})
