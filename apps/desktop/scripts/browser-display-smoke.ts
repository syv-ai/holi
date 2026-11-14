import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { createPages } from '../src/plugins/browser/main/pages'

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
  await win.loadURL(
    'data:text/html,<body style="font:24px sans-serif">Holi browser display isolation</body>',
  )
  let displayed: string | null = 'owner-a'
  const listeners = new Set<(remote: string | null) => void>()
  const makeOwner = (remote: string) =>
    createPages({
      window: () => (displayed === remote ? win : null),
      onDisplayChange: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      changed: () => {},
      reveal: () => {
        reveals += 1
      },
      address: () => {
        addresses += 1
      },
      key: () => {
        shortcuts += 1
      },
    })
  const ownerA = makeOwner('owner-a')
  const ownerB = makeOwner('owner-b')
  const viewA = await ownerA.open({ id: 'duplicate-page-id', reveal: false })
  // The pages module intentionally keeps its WebContentsView private. Observe the
  // native attachment through contentView.children, the public Electron surface.
  ownerA.place(viewA.id, { x: 0, y: 0, width: 500, height: 400 })
  assert.equal(win.contentView.children.length, 1, 'displayed page attaches to native parent')
  checks.push('displayed-page-attached')
  await win.webContents.capturePage().then((image) => {
    assert(!image.isEmpty(), 'native before screenshot was empty')
    writeFileSync(join(evidence, 'browser-before.png'), image.toPNG())
  })
  displayed = null
  for (const cb of [...listeners]) cb(null)
  assert.equal(
    win.contentView.children.length,
    0,
    'departure to null synchronously removes native child',
  )
  checks.push('departure-detaches-synchronously')
  const focusAfterDeparture = win.webContents.isFocused()
  await ownerA.read(viewA.id)
  const hiddenOpened = await ownerA.open({ reveal: true })
  ownerA.place(viewA.id, { x: 1, y: 1, width: 400, height: 300 })
  assert.equal(win.contentView.children.length, 0, 'hidden placement cannot reattach')
  assert.equal(reveals, 0, 'hidden work cannot reveal a tab')
  assert.equal(shortcuts, 0, 'hidden work cannot forward a shortcut')
  assert.equal(addresses, 0, 'hidden work cannot request address focus')
  assert.equal(win.webContents.isFocused(), focusAfterDeparture, 'hidden work cannot focus Holi')
  ownerA.close(hiddenOpened.id)
  checks.push('hidden-read-placement-and-reveal-do-not-act-on-display')
  await win.webContents.capturePage().then((image) => {
    assert(!image.isEmpty(), 'native after screenshot was empty')
    writeFileSync(join(evidence, 'browser-after.png'), image.toPNG())
  })
  displayed = 'owner-b'
  for (const cb of [...listeners]) cb('owner-b')
  const viewB = await ownerB.open({ id: 'duplicate-page-id', reveal: false })
  ownerB.place(viewB.id, { x: 0, y: 0, width: 400, height: 300 })
  assert.equal(win.contentView.children.length, 1, 'new display owner attaches its own page')
  checks.push('new-owner-attaches')
  displayed = 'owner-a'
  for (const cb of [...listeners]) cb('owner-a')
  assert.equal(win.contentView.children.length, 0, 'return requires fresh placement')
  ownerA.place(viewA.id, { x: 0, y: 0, width: 400, height: 300 })
  assert.equal(
    win.contentView.children.length,
    1,
    'fresh placement attaches the same id in owner A',
  )
  checks.push('return-requires-fresh-owner-placement')
  ownerA.dispose()
  ownerB.dispose()
  win.destroy()
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
        screenshots: ['browser-before.png', 'browser-after.png'],
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
