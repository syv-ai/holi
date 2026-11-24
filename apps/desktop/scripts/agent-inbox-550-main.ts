import { app } from 'electron'
import { join, resolve } from 'node:path'

const root = resolve(process.env.HOLI_550_ROOT ?? '')
if (!root || !process.env.HOLI_550_ROOT) throw new Error('HOLI_550_ROOT is required')
for (const [name, path] of Object.entries({
  userData: join(root, 'userData'),
  sessionData: join(root, 'sessionData'),
  appData: join(root, 'appData'),
  logs: join(root, 'logs'),
  crashDumps: join(root, 'crashDumps'),
}))
  app.setPath(name as Parameters<typeof app.setPath>[0], path)
app.setName(`holi-agent-inbox-550-${process.env.HOLI_550_NONCE ?? 'isolated'}`)
for (const path of [
  app.getPath('userData'),
  app.getPath('sessionData'),
  app.getPath('appData'),
  app.getPath('logs'),
  app.getPath('crashDumps'),
]) {
  if (!path.startsWith(`${root}/`)) throw new Error(`Electron path escaped isolated root: ${path}`)
}
// Load the exact production entry only after all Electron storage locations are isolated.
await import('../src/main/index')
