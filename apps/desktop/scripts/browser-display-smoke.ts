import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { browserMain } from '../src/plugins/browser/main/index'
import { pluginEvents } from '../src/main/plugin-host/events'
import type { PluginCtx } from '../src/main/plugin-api'

const root = process.env.HOLI_472_ROOT!
const evidence = process.env.HOLI_472_EVIDENCE!
assert(root && evidence)

async function run(): Promise<void> {
  for (const name of ['profile', 'session', 'vault-a', 'vault-b', 'app-data'])
    mkdirSync(join(root, name), { recursive: true })
  app.setName('Holi Browser Display QA 472')
  app.setPath('appData', join(root, 'app-data'))
  app.setPath('userData', join(root, 'profile'))
  app.setPath('sessionData', join(root, 'session'))
  assert.equal(app.getPath('userData'), join(root, 'profile'))
  await app.whenReady()
  console.log('[472] electron-ready')

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      '<!doctype html><title>Holi isolated browser fixture</title><main><h1>Browser page owned by vault A</h1><label>Search <input aria-label="Search"></label><button>Submit</button><p id="result">ready</p><script>document.querySelector("button").onclick=()=>document.querySelector("#result").textContent=document.querySelector("input").value</script></main>',
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}/`

  const checks: string[] = []
  let reveals = 0
  let shortcuts = 0
  let addresses = 0
  const win = new BrowserWindow({
    width: 900,
    height: 650,
    show: true,
    webPreferences: { sandbox: true },
  })
  await win.loadURL('data:text/html,<body style="font:20px sans-serif">Holi shell window</body>')
  console.log('[472] shell-loaded')
  let displayed: string | null = 'owner-a'
  const listeners = new Set<(remote: string | null) => void>()
  let presentationEpoch = 0
  const makeOwner = async (remote: string) => {
    const handlers = new Set<(message: unknown) => void>()
    let capabilities: Record<string, { run(ctx: unknown, params: unknown): Promise<any> }> = {}
    const events = pluginEvents(
      {
        send: (_channel, event) => {
          if (event.name === 'reveal') reveals += 1
          if (event.name === 'key') shortcuts += 1
          if (event.name === 'address') addresses += 1
        },
        listen: (_channel, handler) => {
          handlers.add(handler)
          return () => handlers.delete(handler)
        },
        liveRemote: () => displayed,
      },
      'browser',
      async () => true,
    )
    const ctx = {
      remote,
      root: join(root, remote === 'owner-a' ? 'vault-a' : 'vault-b'),
      userData: join(root, 'app-data'),
      displayed: () => displayed,
      presentationLease: () => {
        const admitted = presentationEpoch
        return () => displayed === remote && presentationEpoch === admitted
      },
      window: () => (displayed === remote ? win : null),
      onDisplayChange: (cb: (remote: string | null) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      emit: events.emit,
      on: events.on,
      register: (_namespaces: readonly string[], table: typeof capabilities) => {
        capabilities = table
        return () => {}
      },
    } as unknown as PluginCtx
    const dispose = await browserMain.activate!(ctx)
    const invoke = (name: string, params: unknown = {}) =>
      capabilities[`browser.${name}`]!.run({}, params)
    const sendPlace = (id: string, rect: unknown) => {
      const message = { remote, name: 'place', payload: { id, rect } }
      for (const handler of [...handlers]) handler(message)
    }
    return {
      open: (id: string, address: string) => invoke('open', { reopen: id, url: address }),
      sendPlace,
      place: async (id: string, rect: unknown) => {
        sendPlace(id, rect)
        await new Promise<void>((resolve) => setImmediate(resolve))
      },
      read: (id: string) => invoke('read', { tab: id }),
      type: (id: string, ref: number, text: string, submit = false) =>
        invoke('type', { tab: id, ref, text, submit }),
      close: (id: string) => invoke('close', { tab: id }),
      dispose,
    }
  }
  const switchTo = (remote: string | null): void => {
    displayed = remote
    presentationEpoch += 1
    for (const cb of [...listeners]) cb(remote)
  }
  const ownerA = await makeOwner('owner-a')
  const ownerB = await makeOwner('owner-b')
  const viewA = await ownerA.open('duplicate-page-id', url)
  console.log('[472] owner-a-opened', viewA.id)
  await ownerA.place(viewA.id, { x: 0, y: 0, width: 500, height: 400 })
  assert.equal(win.contentView.children.length, 1, 'displayed page attaches to native parent')
  const attachedA = win.contentView.children[0]!
  console.log('[472] attached')
  const initial = await ownerA.read(viewA.id)
  console.log('[472] read-complete')
  assert.match(initial.text, /Browser page owned by vault A/)
  assert(initial.text.length > 30, 'the page must contain real non-empty content')
  checks.push('displayed-page-attached-with-loaded-content')
  await attachedA.webContents.executeJavaScript(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  )
  const pageImage = await attachedA.webContents.capturePage()
  assert(!pageImage.isEmpty(), 'attached native browser child screenshot was empty')
  writeFileSync(join(evidence, 'browser-before.png'), pageImage.toPNG())
  await win.webContents.capturePage().then((image) => {
    assert(!image.isEmpty(), 'native shell screenshot was empty')
    writeFileSync(join(evidence, 'shell-before.png'), image.toPNG())
  })

  // Exercise the production browser page's isolated-world read/type/press path.
  const controls = await ownerA.read(viewA.id)
  assert.match(controls.text, /Search/)
  const inputRef = Number(controls.text.match(/\[(\d+)\] textbox "Search"/)?.[1] ?? 1)
  await ownerA.type(viewA.id, inputRef, 'smoke-value', true)
  const typed = await ownerA.read(viewA.id)
  assert.match(typed.text, /smoke-value/)
  checks.push('hidden-authorized-page-read-type-and-press-work')

  switchTo(null)
  assert.equal(
    win.contentView.children.length,
    0,
    'departure to null synchronously removes native child',
  )
  checks.push('departure-detaches-synchronously')
  win.blur()
  const focusedOther = BrowserWindow.getFocusedWindow()
  await ownerA.type(viewA.id, inputRef, 'hidden-value', true)
  const hiddenRead = await ownerA.read(viewA.id)
  assert.match(hiddenRead.text, /hidden-value/)
  const detached = attachedA.webContents
  detached.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['meta'] })
  detached.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers: ['meta'] })
  assert.equal(reveals, 0, 'hidden work cannot reveal a tab')
  assert.equal(shortcuts, 0, 'hidden work cannot forward a shortcut')
  assert.equal(addresses, 0, 'hidden work cannot request address focus')
  assert.equal(
    BrowserWindow.getFocusedWindow(),
    focusedOther,
    'detached native input cannot focus Holi',
  )
  await ownerA.read(viewA.id)
  const hiddenOpened = await ownerA.open('hidden-tab', url)
  await ownerA.place(viewA.id, { x: 1, y: 1, width: 400, height: 300 })
  assert.equal(win.contentView.children.length, 0, 'hidden placement cannot reattach')
  assert.equal(reveals, 0, 'hidden open cannot reveal a tab')
  await ownerA.close(hiddenOpened.id)
  checks.push('hidden-native-input-and-placement-are-inert')
  await win.webContents.capturePage().then((image) => {
    assert(!image.isEmpty(), 'native after screenshot was empty')
    writeFileSync(join(evidence, 'browser-after.png'), image.toPNG())
  })

  switchTo('owner-b')
  const viewB = await ownerB.open('duplicate-page-id', url)
  await ownerB.place(viewB.id, { x: 0, y: 0, width: 400, height: 300 })
  assert.equal(win.contentView.children.length, 1)
  const attachedB = win.contentView.children[0]!
  assert.notEqual(
    attachedA,
    attachedB,
    'duplicate ids in separate activations are distinct native views',
  )
  checks.push('duplicate-page-ids-have-distinct-native-views')
  switchTo('owner-a')
  assert.equal(win.contentView.children.length, 0, 'return requires fresh placement')
  await ownerA.place(viewA.id, { x: 0, y: 0, width: 500, height: 400 })
  assert.equal(win.contentView.children.length, 1)
  assert.equal(
    win.contentView.children[0],
    attachedA,
    'reattachment preserves exact native view identity',
  )
  checks.push('return-requires-fresh-owner-placement')
  ownerA.sendPlace(viewA.id, { x: 0, y: 0, width: 500, height: 400 })
  await ownerA.close(viewA.id)
  const reincarnated = await ownerA.open(viewA.id, url)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(
    win.contentView.children.length,
    0,
    'queued placement cannot attach a same-id replacement',
  )
  await ownerA.place(reincarnated.id, { x: 0, y: 0, width: 500, height: 400 })
  assert.equal(win.contentView.children.length, 1)
  assert.notEqual(win.contentView.children[0], attachedA)
  checks.push('same-id-reincarnation-rejects-stale-placement')
  switchTo(null)
  assert.equal(win.contentView.children.length, 0)
  checks.push('departure-to-null-removes-replacement')

  await ownerA.dispose()
  await ownerB.dispose()
  win.destroy()
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
          vaultA: join(root, 'vault-a'),
          vaultB: join(root, 'vault-b'),
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
