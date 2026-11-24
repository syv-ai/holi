import { app } from 'electron'
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

try {
  const expected = join(realpathSync(resolve(__dirname, '../..')), 'runtime')
  const root = process.env.HOLI_550_ROOT
  if (!root || root !== expected || realpathSync(root) !== root)
    throw new Error('HOLI_550_ROOT must be the build-owned runtime directory')
  const info = lstatSync(root)
  if (!info.isDirectory() || info.uid !== process.getuid?.())
    throw new Error('Runtime directory is not owned by this user')
  if (
    process.env.HOME !== join(root, 'home') ||
    process.env.HOLI_VAULT_ROOT !== join(root, 'vaults')
  )
    throw new Error('HOME and HOLI_VAULT_ROOT must use the owned runtime')
  const appName = process.env.HOLI_550_APP_NAME
  if (!appName) throw new Error('An owned app name is required')
  app.setName(appName)
  const paths = {
    home: join(root, 'home'),
    temp: join(root, 'tmp'),
    userData: join(root, 'user-data'),
    sessionData: join(root, 'session-data'),
    appData: join(root, 'app-data'),
    crashDumps: join(root, 'crash-dumps'),
  }
  for (const [name, directory] of Object.entries(paths)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    app.setPath(name as Parameters<typeof app.setPath>[0], directory)
  }
  const logs = join(root, 'logs')
  mkdirSync(logs, { recursive: true, mode: 0o700 })
  app.setAppLogsPath(logs)
  writeFileSync(join(root, 'paths.json'), JSON.stringify({ ...paths, logs }))
  // A runtime require keeps production module side effects after isolation,
  // and before Electron readiness and privileged protocol registration.
  createRequire(__filename)(join(__dirname, 'index.js'))
} catch (error) {
  console.error(error)
  app.exit(1)
}
