import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { createInbox } from '../src/plugins/agent/main/inbox/inbox'
import { parseInbox, type InboxFile } from '../src/plugins/agent/main/inbox/rules'

const root = process.env.HOLI_542_ROOT!
const evidence = process.env.HOLI_542_EVIDENCE!
const userData = join(root, 'user-data')
const vaultRoot = join(root, 'vaults')
const remote = 'smoke/542-vault'
const checks: string[] = []
const denied: string[] = []
const captures: string[] = []
const mark = (name: string) => checks.push(name)
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (win: BrowserWindow, expression: string) => {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expression)) return
    await pause(100)
  }
  throw new Error(`Timed out waiting for ${expression}`)
}

async function run() {
  for (const path of [
    userData,
    vaultRoot,
    join(root, 'app-data'),
    join(root, 'session-data'),
    evidence,
  ])
    mkdirSync(path, { recursive: true })
  app.setName('Holi issue 542 smoke')
  app.setPath('appData', join(root, 'app-data'))
  app.setPath('userData', userData)
  app.setPath('sessionData', join(root, 'session-data'))
  process.env.HOLI_VAULT_ROOT = vaultRoot
  assert.equal(app.getPath('userData'), userData)
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^(file|data|devtools):/.test(details.url)) callback({})
    else {
      denied.push(details.url)
      callback({ cancel: true })
    }
  })

  let file: InboxFile = parseInbox({ entries: [], seen: null })
  const notifyCallbacks = new Map<string, () => void>()
  let win: BrowserWindow
  const send = (name: string, payload: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(name, payload)
  }
  const inbox = createInbox({
    store: {
      read: async () => file,
      update: async (edit) => (file = edit(file)),
    },
    notify: (notice) => {
      notifyCallbacks.set(notice.title, () => {
        const target = notice.navigate
        if (target)
          send('vault:navigate', {
            remote,
            plugin: 'agent',
            name: target.name,
            payload: target.payload,
          })
      })
      return true
    },
    changed: (view) => send('smoke-inbox', view),
  })

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: true,
    backgroundColor: '#f8f8f8',
    webPreferences: {
      preload: join(root, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  ipcMain.handle('542-smoke', async (_event, action: string, payload?: unknown) => {
    if (action === 'raise') return inbox.raise(payload as never)
    if (action === 'banner-callback') {
      notifyCallbacks.get(String(payload))?.()
      return true
    }
    if (action === 'capture') {
      await pause(350)
      writeFileSync(join(evidence, String(payload)), (await win.capturePage()).toPNG())
      captures.push(String(payload))
      return true
    }
    return false
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  const errors: string[] = []
  win.webContents.on('console-message', (event) => {
    console.log(`RENDERER ${event.level}: ${event.message}`)
    if (event.level === 'error') errors.push(event.message)
  })
  win.webContents.on('did-fail-load', (_event, code, description) =>
    console.log(`LOAD FAILED ${code}: ${description}`),
  )
  win.webContents.on('render-process-gone', (_event, detail) =>
    errors.push(`renderer gone: ${detail.reason}`),
  )
  await win.loadFile(join(root, 'renderer.html'))
  await waitFor(win, `document.querySelector('[aria-label="Production agent terminal"]')`)

  await win.webContents.executeJavaScript(
    `document.documentElement.setAttribute('data-theme','light')`,
  )
  await win.webContents.executeJavaScript(`window.smoke542.setTheme('light')`)
  await waitFor(win, `document.querySelector('.xterm')`)
  await pause(500)
  await pause(500)
  await win.webContents.executeJavaScript(
    `window.smoke542.pushPty('terminal-pi-542','Pi synthetic PTY output · no paid inference')`,
  )
  assert.equal(
    await win.webContents.executeJavaScript(`window.smoke542.state().terminals.length`),
    3,
  )
  assert.equal(await win.webContents.executeJavaScript(`window.smoke542.state().ptyEvents`), 1)
  mark('production-terminal-surface-mounted-with-controlled-synthetic-pty-data')
  const notice = {
    title: 'Review the 542 smoke deliverable',
    line: 'Controlled inbox entry · no paid agent inference',
    session: 'p0123456789ab',
  }
  assert.equal(await inbox.raise(notice), 'banner')
  await waitFor(win, `document.body.innerText.includes('Review the 542 smoke deliverable')`)
  await win.webContents.executeJavaScript(`window.smoke542.capture('inbox-light.png')`)
  await win.webContents.executeJavaScript(`window.smoke542.setTheme('dark')`)
  await waitFor(win, `document.documentElement.getAttribute('data-theme') === 'dark'`)
  await win.webContents.executeJavaScript(`window.smoke542.capture('inbox-dark.png')`)
  await win.webContents.executeJavaScript(`window.smoke542.setTheme('light')`)
  mark('real-createInbox-entry-pushed-through-agent-inbox-event')
  await win.webContents.executeJavaScript(`window.smoke542.openFirstInboxEntry()`)
  await waitFor(
    win,
    `window.smoke542.activeId().kind === 'session' && window.smoke542.activeId().id === 'p0123456789ab'`,
  )
  await win.webContents.executeJavaScript(`window.smoke542.capture('inbox-session-opened.png')`)
  mark('production-inbox-row-opens-session-through-openSessionAtom')
  await win.webContents.executeJavaScript(
    `window.smoke542.clickBanner('Review the 542 smoke deliverable')`,
  )
  await waitFor(win, `window.smoke542.navigationCount() > 0`)
  mark('stored-notifier-callback-drives-main-ipc-navigation-not-os-banner-click')

  await win.webContents.executeJavaScript(`window.smoke542.setVault('smoke/other-vault')`)
  await win.webContents.executeJavaScript(
    `window.smoke542.pushOpen({id:'fixture',at:new Date().toISOString(),title:'Cross-vault',line:'Should be ignored',session:'p0123456789ab'})`,
  )
  assert.equal(
    await win.webContents.executeJavaScript(`document.body.innerText.includes('Cross-vault')`),
    false,
  )
  mark('cross-vault-banner-event-ignored-after-vault-activation')
  await win.webContents.executeJavaScript(`window.smoke542.setVault('smoke/542-vault')`)
  const openCallsBefore = await win.webContents.executeJavaScript(`window.smoke542.openCalls()`)
  await win.webContents.executeJavaScript(`window.smoke542.closePiTab()`)
  await win.webContents.executeJavaScript(`window.smoke542.reopen('p0123456789ab')`)
  await waitFor(
    win,
    `window.smoke542.activeId().kind === 'session' && window.smoke542.activeId().id === 'p0123456789ab'`,
  )
  assert.equal(
    await win.webContents.executeJavaScript(`window.smoke542.openCalls()`),
    openCallsBefore,
  )
  mark('closed-tab-session-reopen-reuses-retained-terminal-with-zero-extra-open')
  await win.webContents.executeJavaScript(`window.smoke542.openUnavailable()`)
  await waitFor(win, `document.body.innerText.includes('Could not open agent session')`)
  mark('unavailable-session-id-shows-production-error-toast')

  const checksView = await win.webContents.executeJavaScript(`window.smoke542.state()`)
  assert.match(
    checksView.sessions.find((session: { provider: string }) => session.provider === 'pi')?.id,
    /^p[0-9a-f]{12}$/,
  )
  assert.match(
    checksView.sessions.find((session: { provider: string }) => session.provider === 'codex')?.id,
    /^p[0-9a-f]{12}$/,
  )
  assert.match(
    checksView.sessions.find((session: { provider: string }) => session.provider === 'claude')?.id,
    /^[0-9a-f]{8}$/,
  )
  mark('provider-pty-id-formats-pi-codex-and-claude-verified')
  assert.deepEqual(denied, [])
  assert.deepEqual(errors, [])
  assert.equal(process.versions.electron.split('.')[0], '43')
  const result = {
    ok: true,
    issue: 542,
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    checks,
    captures,
    networkDenied: denied,
    rendererErrors: errors,
    notifierInvocation:
      'stored callback invoked by smoke driver; native OS banner click not tested',
    isolatedRoots: {
      userData,
      appData: join(root, 'app-data'),
      sessionData: join(root, 'session-data'),
      vault: vaultRoot,
    },
    rendererState: checksView,
    notifyTitles: [...notifyCallbacks.keys()],
  }
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
  win.destroy()
  app.quit()
}

void run().catch((error: unknown) => {
  writeFileSync(
    join(evidence, 'failure.txt'),
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  )
  console.error(error)
  app.exit(1)
})
