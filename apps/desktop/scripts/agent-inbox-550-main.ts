import { app, BrowserWindow, ipcMain } from 'electron'
import { startInboxNavigation } from './agent-inbox-550-navigation'

import { lstatSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
  const expectedUrl = pathToFileURL(join(root, '../out/renderer/index.html')).href
  let completed = false
  const openedContents = new Set<number>()
  ipcMain.on('vault:open-ready', (event) => {
    if (event.senderFrame === event.sender.mainFrame && event.senderFrame?.url === expectedUrl)
      openedContents.add(event.sender.id)
  })
  const fail = (reason: string) => {
    if (completed) return
    completed = true
    writeFileSync(join(root, 'startup-failure.json'), JSON.stringify({ reason }))
    console.error(reason)
    app.exit(1)
  }
  ipcMain.on('holi-550:preload', (event, report) => {
    if (event.senderFrame !== event.sender.mainFrame)
      return fail('Preload report came from a non-main frame')
    const contents = event.sender
    if (contents.getURL() !== expectedUrl)
      return fail('Preload report came from an unexpected renderer URL')
    if (contents.getType() !== 'window') return fail('Preload report did not come from a window')
    if (report?.sandboxed !== true || report?.contextIsolated !== true)
      return fail('Production preload did not confirm sandbox and context isolation')
    // The fixture preload alone owns this channel. Its production document
    // and native main-frame identity are public Electron checks; private
    // getLastWebPreferences() does not expose a stable preload-path contract.
    if (event.senderFrame?.url !== expectedUrl)
      return fail('Preload frame did not load the production document')
    const poll = async () => {
      if (completed) return
      try {
        const bodyText = await contents.executeJavaScript(
          'document.body?.innerText?.trim() ?? ""',
          true,
        )
        if (
          bodyText &&
          openedContents.has(contents.id) &&
          !/no vault is open\s*retry/i.test(bodyText)
        ) {
          completed = true
          writeFileSync(
            join(root, 'startup-ready.json'),
            JSON.stringify({
              rendererLoaded: true,
              sandboxed: true,
              contextIsolated: true,
              vaultOpened: true,
              url: contents.getURL(),
              bodyText,
            }),
          )
          if (process.env.HOLI_550_SCENARIO === 'inbox-path')
            void startInboxNavigation(contents, root).catch((error) => {
              writeFileSync(
                join(root, 'inbox-navigation.json'),
                JSON.stringify({ ok: false, error: String(error) }),
              )
            })
          return
        }
      } catch (error) {
        return fail(`Could not inspect the loaded production renderer: ${String(error)}`)
      }
      if (Date.now() >= deadline)
        return fail('Production vault did not become ready before timeout')
      setTimeout(poll, 100)
    }
    const deadline = Date.now() + 45000
    poll()
  })
  app.on('web-contents-created', (_event, contents) => {
    contents.once('did-finish-load', () => {
      if (contents.getURL() === expectedUrl && !completed) {
        setTimeout(() => {
          if (!completed) fail('Production renderer/vault startup did not become ready')
        }, 50000)
      }
    })
  })
  // Register evidence listeners before production startup creates its window.
  createRequire(__filename)(join(__dirname, 'index.js'))
} catch (error) {
  console.error(error)
  app.exit(1)
}
