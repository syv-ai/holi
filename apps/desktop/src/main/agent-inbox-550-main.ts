import { app } from 'electron'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

void (async () => {
  const root = process.env.HOLI_550_ROOT
  const vault = process.env.HOLI_VAULT_ROOT
  if (!root || !isAbsolute(root) || !vault || !isAbsolute(vault))
    throw new Error('HOLI_550_ROOT and HOLI_VAULT_ROOT must be absolute paths')
  const runtimeRoot = resolve(root)
  const vaultRoot = resolve(vault)
  const within = (parent: string, child: string) => {
    const rel = relative(parent, child)
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  }
  if (!within(runtimeRoot, vaultRoot))
    throw new Error('HOLI_VAULT_ROOT must be inside HOLI_550_ROOT')
  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(vaultRoot, { recursive: true })
  app.setName(`Holi 550 ${process.pid}-${Date.now()}`)
  const paths = {
    userData: join(runtimeRoot, 'user-data'),
    sessionData: join(runtimeRoot, 'session-data'),
    appData: join(runtimeRoot, 'app-data'),
    crashDumps: join(runtimeRoot, 'crash-dumps'),
    logs: join(runtimeRoot, 'logs'),
  }
  for (const path of Object.values(paths)) await mkdir(path, { recursive: true })
  app.setPath('userData', paths.userData)
  app.setPath('sessionData', paths.sessionData)
  app.setPath('appData', paths.appData)
  app.setPath('crashDumps', paths.crashDumps)
  app.setAppLogsPath(paths.logs)
  await import(pathToFileURL(join(dirname(__filename), 'index.js')).href)
})().catch((error) => {
  console.error(error)
  app.quit()
})
