import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, type WebContentsView } from 'electron'
import { browserMain } from '../src/plugins/browser/main/index'
import { createPluginHost, type OpenVault } from '../src/main/plugin-host/host'
import { createCapabilityRegistry } from '../src/main/capabilities/registry'
import { noCoreServices } from '../src/main/capabilities/services'
import type { MainPlugin } from '../src/main/plugin-api'
import type { PluginEvent } from '../src/main/plugin-host/events'
import type { PageInfo, PageRead } from '../src/plugins/browser/shared/page'

const root = process.env.HOLI_472_ROOT!
const evidence = process.env.HOLI_472_EVIDENCE!
assert(root && evidence)
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const rect = { x: 0, y: 0, width: 700, height: 450 }

async function run(): Promise<void> {
  for (const name of ['profile', 'session', 'vault-a', 'vault-b', 'app-data'])
    mkdirSync(join(root, name), { recursive: true })
  app.setName('Holi Browser Display QA 472')
  app.setPath('appData', join(root, 'app-data'))
  app.setPath('userData', join(root, 'profile'))
  app.setPath('sessionData', join(root, 'session'))
  assert.equal(app.getPath('userData'), join(root, 'profile'))
  await app.whenReady()
  const checks: string[] = []
  const mark = (name: string) => {
    checks.push(name)
    console.log(`PASS ${name}`)
  }
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>Vault ${request.url === '/b' ? 'B' : 'A'} browser page</title>
      <main><h1>Browser page owned by vault ${request.url === '/b' ? 'B' : 'A'}</h1>
      <label>Search <input aria-label="Search"></label><button>Submit</button><p>Local fixture, no accounts</p></main>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const nativeRequests: { webContentsId: number; processId: number; routingId: number }[] = []
  // This is Electron 43's native provenance seam: protocol Request itself
  // does not expose a webContentsId, while webRequest details do.
  const defaultSession = (await import('electron')).session.defaultSession
  defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith('http://127.0.0.1:')) {
      nativeRequests.push({
        webContentsId: details.webContentsId,
        processId: details.frame.processId,
        routingId: details.frame.routingId,
      })
    }
    callback({})
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  const win = new BrowserWindow({
    width: 900,
    height: 650,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  await win.loadURL('data:text/html,<h1>Holi shell: no browser page attached</h1>')
  await win.loadURL(`${url}/a`)
  assert(
    nativeRequests.some(
      (request) =>
        request.webContentsId === win.webContents.id &&
        Number.isInteger(request.processId) &&
        Number.isInteger(request.routingId),
    ),
    'Electron webRequest did not expose exact native requester and frame provenance',
  )
  mark('electron43-webrequest-native-window-and-frame-provenance')
  await win.loadURL('data:text/html,<h1>Holi shell: no browser page attached</h1>')
  const roots = { A: join(root, 'vault-a'), B: join(root, 'vault-b') }
  for (const vault of Object.values(roots)) {
    mkdirSync(join(vault, '.holi/settings'), { recursive: true })
    writeFileSync(
      join(vault, '.holi/settings/plugins.yaml'),
      'plugins:\n  browser: true\n  delayed: false\n',
    )
  }
  const registry = createCapabilityRegistry()
  const listeners = new Set<(message: unknown) => void>()
  const sent: PluginEvent[] = []
  let gate: { wait: Promise<void>; entered(): void } | undefined
  let activationGate: { wait: Promise<void>; entered(): void } | undefined
  const delayed: MainPlugin = {
    info: { id: 'delayed', label: 'Delayed', default: false },
    async activate() {
      const pending = activationGate
      if (pending) {
        pending.entered()
        await pending.wait
      }
      return () => {}
    },
  }
  const host = createPluginHost({
    plugins: [browserMain, delayed],
    registry,
    userData: join(root, 'profile'),
    coreSeeds: [],
    active: () => null,
    rootFor: async (remote) => {
      const pending = gate
      if (pending) {
        pending.entered()
        await pending.wait
      }
      return roots[remote as keyof typeof roots] ?? null
    },
    events: {
      send: (_channel, event) => {
        sent.push(event)
      },
      listen: (_channel, handler) => {
        listeners.add(handler)
        return () => {
          listeners.delete(handler)
        }
      },
      liveRemote: () => host.displayed(),
    },
    openAppDoor: () => {
      throw new Error('no app door in browser smoke')
    },
    route: () => () => {},
    binDir: () => root,
    githubToken: () => null,
    frameOrigin: () => () => {},
    notify: () => false,
    focused: () => win.isFocused(),
    window: () => win,
  })
  const vault = (remote: keyof typeof roots): OpenVault => ({
    remote,
    root: roots[remote],
    pause: () => {},
    resume: () => {},
    commitNow: async () => null,
    repo: { head: async () => null },
  })
  const invoke = async <T>(remote: keyof typeof roots, name: string, params: unknown): Promise<T> =>
    (
      await registry.run(
        `browser.${name}`,
        'cli',
        {
          remote,
          root: roots[remote],
          bundle: null,
          core: noCoreServices(),
          claims: async () => [],
          snapshot: async () => {
            throw new Error('unused snapshot')
          },
        },
        params,
      )
    ).value as T
  const place = (remote: string, value: typeof rect | null, id = 'same') => {
    for (const listener of [...listeners])
      listener({ remote, name: 'place', payload: { id, rect: value } })
  }
  const child = () => win.contentView.children[0] as WebContentsView
  const block = () => {
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    gate = {
      wait: new Promise<void>((resolve) => {
        release = resolve
      }),
      entered,
    }
    return {
      waiting,
      release: () => {
        gate = undefined
        release()
      },
    }
  }
  const displayEvents = () => sent.filter((e) => ['reveal', 'address', 'key'].includes(e.name))
  const nativeKey = (view: WebContentsView, key: string) => {
    const input = {
      type: 'keyDown',
      key,
      code: `Key${key.toUpperCase()}`,
      meta: true,
      control: true,
      alt: false,
      shift: false,
    }
    // Exercise the actual registered Electron callback deterministically, including
    // detached views for which Chromium does not dispatch physical keyboard input.
    view.webContents.emit('before-input-event', { preventDefault() {} }, input)
  }
  host.setDisplayed('A')
  await host.reconcile(vault('A'), 'open')
  await host.reconcile(vault('B'), 'open')
  assert.deepEqual(host.failures('A'), {})
  assert.deepEqual(host.failures('B'), {})
  mark('production-host-and-browser-activations')
  await invoke<PageInfo>('A', 'open', { reopen: 'same', shown: true })
  place('A', rect)
  await tick()
  assert.equal(win.contentView.children.length, 1)
  const a = child()
  await invoke('A', 'open', { tab: 'same', url: `${url}/a` })
  const initial = await invoke<PageRead>('A', 'read', { tab: 'same' })
  assert.match(initial.text, /Browser page owned by vault A/)
  mark('displayed-page-attached-with-loaded-content')
  const capture = async (view: WebContentsView['webContents'], name: string) => {
    // CDP requests a rendered frame even when the native test window is occluded.
    // No debugger port, visibility override or substitute renderer is involved.
    view.debugger.attach('1.3')
    try {
      await view.debugger.sendCommand('Page.enable')
      const image = (await view.debugger.sendCommand('Page.captureScreenshot', {
        captureBeyondViewport: true,
        fromSurface: true,
      })) as { data: string }
      assert(image.data.length > 0, `empty screenshot: ${name}`)
      writeFileSync(join(evidence, name), Buffer.from(image.data, 'base64'))
    } finally {
      view.debugger.detach()
    }
  }
  await capture(win.webContents, 'shell-before.png')
  await capture(a.webContents, 'browser-before.png')
  const match = initial.text.match(/\[(\d+)\] textbox "Search"/)
  assert(match, initial.text)
  const ref = Number(match[1])
  nativeKey(a, 'l')
  await tick()
  assert(
    displayEvents().some((e) => e.name === 'address'),
    'positive native input control',
  )
  sent.length = 0
  const staleKey = block()
  nativeKey(a, 'w')
  await staleKey.waiting
  place('A', null)
  staleKey.release()
  await tick()
  assert.equal(displayEvents().length, 0, 'hidden attachment rejects queued shortcut')
  mark('queued-native-action-expires-on-tab-hide')
  place('A', rect)
  await tick()
  const staleDisplay = block()
  nativeKey(a, 'w')
  await staleDisplay.waiting
  host.setDisplayed('B')
  assert.equal(win.contentView.children.length, 0)
  host.setDisplayed('A')
  staleDisplay.release()
  await tick()
  assert.equal(displayEvents().length, 0)
  assert.equal(win.contentView.children.length, 0)
  mark('departure-detaches-synchronously')
  mark('queued-action-expires-across-return')
  host.setDisplayed(null)
  assert.equal(win.contentView.children.length, 0)
  const focus = win.webContents.isFocused()
  await invoke('A', 'type', { tab: 'same', ref, text: 'hidden-value' })
  await invoke('A', 'press', { tab: 'same', key: 'Enter' })
  assert.match((await invoke<PageRead>('A', 'read', { tab: 'same' })).text, /hidden-value/)
  nativeKey(a, 'l')
  nativeKey(a, 'w')
  place('A', rect)
  await tick()
  assert.equal(displayEvents().length, 0)
  assert.equal(win.contentView.children.length, 0)
  assert.equal(win.webContents.isFocused(), focus)
  mark('hidden-authorized-page-read-type-and-press-work')
  mark('hidden-native-input-and-placement-are-inert')
  await a.webContents.executeJavaScript('window.open("/popup"); true')
  const hiddenTabs = await invoke<PageInfo[]>('A', 'tabs', {})
  assert.equal(hiddenTabs.length, 2, 'hidden popup remains bound to its originating activation')
  await tick()
  assert.equal(displayEvents().length, 0)
  assert.equal(win.contentView.children.length, 0)
  const popupId = hiddenTabs.find((page) => page.id !== 'same')!.id
  assert.match((await invoke<PageRead>('A', 'read', { tab: popupId })).text, /vault A/)
  await invoke('A', 'close', { tab: popupId })
  mark('hidden-popup-keeps-data-without-presentation')
  await capture(win.webContents, 'browser-after.png')
  host.setDisplayed('B')
  await invoke('B', 'open', { reopen: 'same', url: `${url}/b`, shown: true })
  place('B', rect)
  await tick()
  const b = child()
  assert(b && b !== a)
  mark('duplicate-page-ids-have-distinct-native-views')
  host.setDisplayed('A')
  assert.equal(win.contentView.children.length, 0)
  place('A', rect)
  await tick()
  assert.equal(child(), a)
  mark('return-requires-fresh-owner-placement')
  const oldPlace = block()
  place('A', rect)
  await oldPlace.waiting
  await invoke('A', 'close', { tab: 'same' })
  await invoke('A', 'open', { reopen: 'same', url: `${url}/a`, shown: true })
  oldPlace.release()
  await tick()
  assert.equal(win.contentView.children.length, 0)
  place('A', rect)
  await tick()
  assert(child() && child() !== a)
  mark('same-id-reincarnation-rejects-stale-placement')
  host.setDisplayed('B')
  place('B', rect)
  await tick()
  await host.stop('A')
  assert.equal(child(), b)
  assert.match((await invoke<PageRead>('B', 'read', { tab: 'same' })).text, /vault B/)
  mark('stopping-a-preserves-b-native-view-and-capabilities')
  host.setDisplayed(null)
  assert.equal(win.contentView.children.length, 0)
  mark('departure-to-null-removes-replacement')
  // Reconcile can hold disposal behind plugin activation. Display departure must
  // detach the native child before that activation is released, for both stop APIs.
  for (const [index, [stop, target, check]] of [
    [() => host.stop('A'), 'B', 'pending-reconcile-stop-detaches-to-b'],
    [() => host.stop('A'), null, 'pending-reconcile-stop-detaches-to-null'],
    [() => host.stopAll(), 'B', 'pending-reconcile-stop-all-detaches-to-b'],
    [() => host.stopAll(), null, 'pending-reconcile-stop-all-detaches-to-null'],
  ].entries()) {
    if (index > 0) {
      writeFileSync(
        join(roots.A, '.holi/settings/plugins.yaml'),
        'plugins:\n  browser: true\n  delayed: false\n',
      )
      await host.reconcile(vault('A'), 'settings')
    }
    await host.reconcile(vault('A'), 'open')
    host.setDisplayed('A')
    await invoke('A', 'open', { reopen: 'same', url: `${url}/a`, shown: true })
    place('A', rect)
    await tick()
    assert.equal(win.contentView.children.length, 1)
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    activationGate = {
      wait: new Promise<void>((resolve) => {
        release = resolve
      }),
      entered,
    }
    writeFileSync(
      join(roots.A, '.holi/settings/plugins.yaml'),
      'plugins:\n  browser: true\n  delayed: true\n',
    )
    const reconciling = host.reconcile(vault('A'), 'settings')
    await waiting
    const stopping = stop()
    host.setDisplayed(target)
    assert.equal(win.contentView.children.length, 0, 'stopping owner detaches synchronously')
    host.setDisplayed('A')
    place('A', rect)
    await tick()
    assert.equal(win.contentView.children.length, 0, 'stopping owner cannot reattach on return')
    host.setDisplayed(target)
    activationGate = undefined
    release()
    await Promise.all([reconciling, stopping])
    mark(check)
  }
  assert.equal(listeners.size, 0)
  win.destroy()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  writeFileSync(
    join(evidence, 'result.json'),
    JSON.stringify(
      {
        ok: true,
        checks,
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
        roots: {
          app: root,
          profile: join(root, 'profile'),
          session: join(root, 'session'),
          vaultA: roots.A,
          vaultB: roots.B,
        },
        screenshots: ['browser-before.png', 'shell-before.png', 'browser-after.png'],
      },
      null,
      2,
    ),
  )
  app.quit()
}

void run().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
