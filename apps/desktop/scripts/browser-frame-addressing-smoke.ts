import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { runFrameAddressingScenarios } from './browser-frame-addressing-scenarios'

const root = process.env.HOLI_670_ROOT!
const evidence = process.env.HOLI_670_EVIDENCE!
const checks: string[] = []
const check: (condition: unknown, name: string) => asserts condition = (condition, name) => {
  assert(condition, name)
  checks.push(name)
  console.log(`PASS ${name}`)
}

async function run() {
  for (const name of ['profile', 'app-data', 'session-data'])
    mkdirSync(join(root, name), { recursive: true })
  app.setName('Holi Frame Addressing Smoke')
  app.setPath('appData', join(root, 'app-data'))
  app.setPath('userData', join(root, 'profile'))
  app.setPath('sessionData', join(root, 'session-data'))
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let permitted = false
    try {
      const url = new URL(details.url)
      permitted = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    } catch {}
    callback({ cancel: !permitted })
  })
  const server = createServer((request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; frame-src http://127.0.0.1:* http://localhost:*",
    })
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    if (url.pathname === '/') {
      response.end(
        `<iframe id="same-a" name="duplicate" src="/child"></iframe><iframe id="same-b" name="duplicate" src="/child"></iframe><iframe id="cross" name="duplicate" src="${process.env.HOLI_670_CROSS_ENTRY}/child/cross"></iframe><script>document.querySelector('#same-a').addEventListener('load', () => { const frame = document.createElement('iframe'); frame.id = 'same-nested'; frame.name = 'same-nested'; frame.src = '/child/same-grandchild'; document.querySelector('#same-a').contentDocument.body.append(frame) })</script><button id="trusted" style="position:fixed;top:0;left:0;z-index:999999" onclick="document.body.dataset.clicked=String(event.isTrusted)">native input</button>`,
      )
    } else if (url.pathname.endsWith('/cross')) {
      response.end(
        `<body>cross<iframe id="cross-nested" name="cross-nested" src="${process.env.HOLI_670_CROSS_ENTRY}/grandchild"></iframe></body>`,
      )
    } else {
      response.end(`<!doctype html><body>${url.pathname}</body>`)
    }
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  let window: BrowserWindow | undefined
  try {
    const entry = `http://127.0.0.1:${address.port}/`
    window = new BrowserWindow({
      show: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    await window.loadURL(entry)
    const wc = window.webContents
    await runFrameAddressingScenarios({
      contents: wc,
      window,
      port: address.port,
      evidence,
      checks,
      check,
    })
  } finally {
    if (window && !window.isDestroyed()) window.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    app.quit()
  }
}

void run().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
