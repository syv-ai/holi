import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, session, type WebContentsView } from 'electron'
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
  const isolatedBrowserSession = session.fromPartition('persist:holi-browser')
  isolatedBrowserSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false
    try {
      const target = new URL(details.url)
      allowed = target.protocol === 'http:' && target.hostname === '127.0.0.1'
    } catch {
      allowed = false
    }
    callback({ cancel: !allowed })
  })
  const checks: string[] = []
  const mark = (name: string) => {
    checks.push(name)
    console.log(`PASS ${name}`)
  }
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><meta name="color-scheme" content="light dark"><style>body { color: CanvasText; background: Canvas; font: 16px sans-serif; }</style><title>Vault ${request.url === '/b' ? 'B' : 'A'} browser page</title>
      <main><h1>Browser page owned by vault ${request.url === '/b' ? 'B' : 'A'}</h1>
      <label>Search <input aria-label="Search" id="search"></label><button>Submit</button>
      <label>Text <input aria-label="Text" id="text" value="one two three"></label>
      <label>Lines <textarea aria-label="Lines" id="lines">first line\nsecond line</textarea></label>
      <label>Password <input aria-label="Password" type="password" id="password"></label>
      <label>Number <input aria-label="Number" type="number" id="number" value="12"></label>
      <p>Local fixture, no accounts</p></main>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
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
    // Existing display-isolation assertion exercises the callback on detached views.
    view.webContents.emit('before-input-event', { preventDefault() {} }, input)
  }
  const nativePress = async (view: WebContentsView, key: string, code?: string) => {
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: code ?? key })
    if (key.length === 1) view.webContents.sendInputEvent({ type: 'char', keyCode: key })
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode: code ?? key })
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  const inPage = <T>(view: WebContentsView, expression: string) =>
    view.webContents.executeJavaScript(expression) as Promise<T>
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
  const capture = async (
    view: WebContentsView['webContents'],
    name: string,
    colorScheme?: 'light' | 'dark',
  ) => {
    // CDP requests a rendered frame even when the native test window is occluded.
    // No debugger port, visibility override or substitute renderer is involved.
    view.debugger.attach('1.3')
    try {
      await view.debugger.sendCommand('Page.enable')
      if (colorScheme !== undefined)
        await view.debugger.sendCommand('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: colorScheme }],
        })
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
  await capture(a.webContents, 'browser-before.png', 'light')
  await capture(a.webContents, 'browser-dark.png', 'dark')
  const match = initial.text.match(/\[(\d+)\] textbox "Search"/)
  assert(match, initial.text)
  const ref = Number(match[1])
  const waitFor = async <T>(read: () => T | undefined, label: string): Promise<T> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = read()
      if (value !== undefined) return value
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  const vimSnapshot = await waitFor(
    () =>
      sent.find((event) => event.remote === 'A' && event.name === 'vim-mode')?.payload as
        | { id: string; nonce: string; attachment: string; revision: number; mode: string }
        | undefined,
    'production browser vim mode snapshot',
  )
  const configureVim = (snapshot: typeof vimSnapshot, enabled: boolean, revision: number) => {
    for (const listener of [...listeners])
      listener({
        remote: 'A',
        name: 'vim-config',
        payload: {
          id: 'same',
          enabled,
          revision,
          nonce: snapshot.nonce,
          attachment: snapshot.attachment,
        },
      })
  }
  configureVim(vimSnapshot, true, 1)
  await inPage(a, `document.querySelector('#text').focus()`)
  configureVim(vimSnapshot, false, 3)
  configureVim(vimSnapshot, true, 2)
  await nativePress(a, 'Escape')
  const staleConfigMode = await waitFor(() => {
    const event = sent.findLast((entry) => entry.remote === 'A' && entry.name === 'vim-mode')
    return (event?.payload as { mode?: string } | undefined)?.mode === 'insert' ? event : undefined
  }, 'stale config leaves browser Vim disabled')
  assert.equal((staleConfigMode.payload as { mode: string }).mode, 'insert')
  mark('stale-vim-disable-request-rejected')
  configureVim(vimSnapshot, true, 4)
  await inPage(a, `document.querySelector('#text').focus()`)
  await waitFor(
    () => sent.findLast((event) => event.remote === 'A' && event.name === 'vim-mode'),
    'configured browser vim mode',
  )
  await nativePress(a, 'Escape')
  const normalMode = await waitFor(() => {
    const event = sent.findLast((entry) => entry.remote === 'A' && entry.name === 'vim-mode')
    return (event?.payload as { mode?: string } | undefined)?.mode === 'normal' ? event : undefined
  }, 'normal mode after native Escape')
  assert.equal((normalMode.payload as { mode: string }).mode, 'normal')
  await inPage(
    a,
    `document.querySelector('#search').value = 'kept'; document.querySelector('#search').focus()`,
  )
  await nativePress(a, 'Escape')
  await nativePress(a, 'Escape')
  assert.equal(await inPage<string>(a, `document.querySelector('#search').value`), 'kept')
  mark('native-normal-escape-preserves-search-value')
  await inPage(
    a,
    `document.querySelector('#lines').value = '\\n  café🙂'; document.querySelector('#lines').focus()`,
  )
  await nativePress(a, 'Escape')
  await inPage(a, `document.querySelector('#lines').setSelectionRange(1, 1)`)
  await nativePress(a, 'k')
  assert.equal(await inPage<number>(a, `document.querySelector('#lines').selectionStart`), 0)
  await nativePress(a, '0')
  assert.equal(await inPage<number>(a, `document.querySelector('#lines').selectionStart`), 0)
  mark('native-leading-newline-line-start')
  await inPage(
    a,
    `document.querySelector('#text').setSelectionRange(0, 0); document.querySelector('#text').focus()`,
  )
  await nativePress(a, 'Escape')
  await inPage(a, `document.querySelector('#text').setSelectionRange(0, 0)`)
  const beforeNormalText = await inPage<string>(a, `document.querySelector('#text').value`)
  await nativePress(a, 'w')
  assert.equal(await inPage<number>(a, `document.querySelector('#text').selectionStart`), 4)
  await nativePress(a, 'e')
  assert.equal(await inPage<number>(a, `document.querySelector('#text').selectionStart`), 6)
  await nativePress(a, 'e')
  assert.equal(await inPage<number>(a, `document.querySelector('#text').selectionStart`), 12)
  await inPage(a, `document.querySelector('#text').setSelectionRange(4, 4)`)
  await nativePress(a, 'x')
  assert.equal(await inPage<string>(a, `document.querySelector('#text').value`), beforeNormalText)
  await nativePress(a, 'i')
  await inPage(
    a,
    `window.nativeInputEvents = 0; document.querySelector('#text').addEventListener('input', () => window.nativeInputEvents++)`,
  )
  await nativePress(a, 'X')
  assert.equal(await inPage<string>(a, `document.querySelector('#text').value`), 'one Xtwo three')
  assert.equal(
    await inPage<number>(a, `window.nativeInputEvents`),
    1,
    'native insert emits one input event',
  )
  a.webContents.undo()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(await inPage<string>(a, `document.querySelector('#text').value`), beforeNormalText)
  a.webContents.redo()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(await inPage<string>(a, `document.querySelector('#text').value`), 'one Xtwo three')
  mark('native-browser-vim-mode-navigation-insertion-undo-redo')
  place('A', null)
  place('A', rect)
  const reattachedVim = await waitFor(() => {
    const event = sent.findLast((entry) => entry.remote === 'A' && entry.name === 'vim-mode')
    const snapshot = event?.payload as typeof vimSnapshot | undefined
    return snapshot && snapshot.attachment !== vimSnapshot.attachment ? snapshot : undefined
  }, 'fresh attachment Vim snapshot')
  configureVim(reattachedVim, true, 1)
  await inPage(a, `document.querySelector('#text').focus()`)
  await nativePress(a, 'Escape')
  const reattachedMode = await waitFor(() => {
    const event = sent.findLast((entry) => entry.remote === 'A' && entry.name === 'vim-mode')
    return (event?.payload as { mode?: string } | undefined)?.mode === 'normal' ? event : undefined
  }, 'Vim rearmed after fresh attachment')
  assert.equal((reattachedMode.payload as { mode: string }).mode, 'normal')
  mark('vim-rearms-after-native-reattachment')
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
        screenshots: [
          'browser-before.png',
          'browser-dark.png',
          'shell-before.png',
          'browser-after.png',
        ],
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
