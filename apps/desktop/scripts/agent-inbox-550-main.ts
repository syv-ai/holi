import { app } from 'electron'
import { lstatSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { ownedFixtureDirectory } from './owned-fixture-directory'

try {
  const expected = join(realpathSync(resolve(__dirname, '../..')), 'runtime')
  const root = process.env.HOLI_550_ROOT
  if (!root || root !== expected || realpathSync(root) !== root)
    throw new Error('HOLI_550_ROOT must be the build-owned runtime directory')
  const info = lstatSync(root)
  if (!info.isDirectory() || info.uid !== process.getuid?.())
    throw new Error('Runtime directory is not owned by this user')
  if (
    process.env.HOME !== ownedFixtureDirectory(root, 'home') ||
    process.env.HOLI_VAULT_ROOT !== join(root, 'vaults')
  )
    throw new Error('HOME and HOLI_VAULT_ROOT must use the owned runtime')
  ownedFixtureDirectory(root, 'vaults')
  const appName = process.env.HOLI_550_APP_NAME
  if (!appName) throw new Error('An owned app name is required')
  app.setName(appName)
  const paths = {
    home: ownedFixtureDirectory(root, 'home'),
    temp: ownedFixtureDirectory(root, 'tmp'),
    userData: ownedFixtureDirectory(root, 'user-data'),
    sessionData: ownedFixtureDirectory(root, 'session-data'),
    appData: ownedFixtureDirectory(root, 'app-data'),
    crashDumps: ownedFixtureDirectory(root, 'crash-dumps'),
  }
  for (const [name, directory] of Object.entries(paths)) {
    app.setPath(name as Parameters<typeof app.setPath>[0], directory)
  }
  const logs = ownedFixtureDirectory(root, 'logs')
  app.setAppLogsPath(logs)
  writeFileSync(join(root, 'paths.json'), JSON.stringify({ ...paths, logs }), { flag: 'wx' })
  // A runtime require keeps production module side effects after isolation,
  // and before Electron readiness and privileged protocol registration.
  createRequire(__filename)(join(__dirname, 'index.js'))
} catch (error) {
  console.error(error)
  app.exit(1)
}
