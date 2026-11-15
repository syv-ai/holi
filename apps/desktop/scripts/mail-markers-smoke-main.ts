import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyVaultSnapshot } from '@holi/shared'
import { createCapabilityRegistry } from '../src/main/capabilities/registry'
import { noCoreServices } from '../src/main/capabilities/services'
import type { GoogleAccountsManager } from '../src/plugins/google/main/accounts'
import { GoogleApi } from '../src/plugins/google/main/api'
import type { GoogleCache } from '../src/plugins/google/main/cache'
import { googleCapabilities, GOOGLE_NAMESPACES } from '../src/plugins/google/main/capabilities'
import { createGoogleData } from '../src/plugins/google/main/data'
import { createMailMarkerStore } from '../src/plugins/google/main/markers'
import type { GoogleSession } from '../src/plugins/google/main/session'

const root = process.env.HOLI_463_ROOT!
const evidence = process.env.HOLI_463_EVIDENCE!
const storeRoot = join(root, 'user-data')
const vaultRoot = join(root, 'vault')
const subA = 'smoke-account-a'
const subB = 'smoke-account-b'
const remote = 'smoke/vault'
const checks: string[] = []
const captures: string[] = []
const denied: string[] = []
const mark = (name: string) => {
  checks.push(name)
  console.log(`PASS ${name}`)
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitFor(win: BrowserWindow, expression: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await win.webContents.executeJavaScript(expression)) return
    await pause(50)
  }
  console.error(
    await win.webContents.executeJavaScript(
      `JSON.stringify({body:document.body.innerText, active:document.activeElement?.outerHTML, keys:window.smokeKeys, calls:window.smokeCalls, errors:window.smokeErrors})`,
    ),
  )
  throw new Error(
    `Native UI did not reach: ${expression}; state=${await win.webContents.executeJavaScript(`JSON.stringify({body:document.body.innerText, active:document.activeElement?.outerHTML, keys:window.smokeKeys, calls:window.smokeCalls, errors:window.smokeErrors})`)}`,
  )
}

async function run() {
  for (const path of [
    storeRoot,
    vaultRoot,
    join(root, 'app-data'),
    join(root, 'session-data'),
    join(evidence, 'frames'),
  ])
    mkdirSync(path, { recursive: true })
  app.setName('Holi mail markers smoke 463')
  app.setPath('appData', join(root, 'app-data'))
  app.setPath('userData', storeRoot)
  app.setPath('sessionData', join(root, 'session-data'))
  process.env.HOLI_VAULT_ROOT = vaultRoot
  assert.equal(app.getPath('userData'), storeRoot)
  await app.whenReady()
  globalThis.fetch = async (input) => {
    denied.push(String(input))
    throw new Error('Unexpected native network request')
  }
  const markersA = createMailMarkerStore(storeRoot, subA)
  const markersB = createMailMarkerStore(storeRoot, subB)
  assert.deepEqual((await markersA.preferences()).enabledOrder, ['yellow-star'])
  await markersA.set('thread-yellow', 'yellow-star')
  await markersA.set('thread-red', 'red-star')
  await markersA.set('thread-blue', 'blue-question')
  await markersB.set('thread-red', 'yellow-star')
  mark('production-default-marker-preferences')
  let currentSub = subA
  const sessions = new Map(
    [subA, subB].map((sub) => [
      sub,
      {
        accountSub: sub,
        account: { sub, email: `${sub === subA ? 'account-a' : 'account-b'}@example.test` },
        missingScopes: () => [],
        getAccessToken: async () => 'synthetic-offline-fixture',
      } as unknown as GoogleSession,
    ]),
  )
  let apiRequests = 0
  const fixtureApi = new GoogleApi({
    accessToken: async () => 'synthetic-offline-fixture',
    fetch: async (_input, init) => {
      assert.equal(init?.method, 'POST', 'display must not introduce Gmail reads')
      apiRequests++
      return Response.json({})
    },
  })
  const newData = (sub: string) =>
    createGoogleData({
      api: () => fixtureApi,
      cache: { patchThread() {}, retire() {} } as unknown as GoogleCache,
      markers: createMailMarkerStore(storeRoot, sub),
    })
  let data = new Map([subA, subB].map((sub) => [sub, newData(sub)]))
  const registry = createCapabilityRegistry()
  registry.register(
    GOOGLE_NAMESPACES,
    googleCapabilities({
      accounts: {
        sessionFor: async (owner: string) => {
          assert.equal(owner, remote)
          return sessions.get(currentSub)!
        },
        overview: async () => ({ state: 'connected' }),
        list: () => [...sessions.values()].map((value) => value.account),
        link: async (owner: string, sub: string) => {
          assert.equal(owner, remote)
          assert(sessions.has(sub))
          currentSub = sub
        },
      } as unknown as GoogleAccountsManager,
      dataFor: async () => data.get(currentSub)!,
      dataForSession: (owner) => data.get(owner.accountSub!)!,
      settings: {
        read: async () => ({ calendars: {}, imageSenders: [], imagesFromAllSenders: false }),
        write: async () => {},
      },
    }),
  )
  const context = {
    remote,
    root: vaultRoot,
    bundle: null,
    snapshot: async () => emptyVaultSnapshot(),
    claims: async () => [],
    core: noCoreServices(),
  }
  const allowed = new Set([
    'google.status',
    'google.allAccounts',
    'google.useAccount',
    'google.mailMarkerPreferences',
    'google.setMailMarkerPreferences',
    'google.mailMarkerAnnotations',
    'google.star',
    'google.mark-read',
    'google.imageSenders',
  ])
  let failAnnotations = 0
  let delayNext: null | { started: () => void; released: Promise<void> } = null
  const nativeCalls: string[] = []
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^(file|data|devtools):/.test(details.url)) return callback({})
    denied.push(details.url)
    callback({ cancel: true })
  })
  shell.openExternal = async () => undefined
  const rendererErrors: string[] = []
  const win = new BrowserWindow({
    width: 1250,
    height: 1000,
    show: true,
    webPreferences: {
      preload: join(root, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  ipcMain.handle(
    'holi-marker-smoke',
    async (
      event,
      op: { path: string; input: { remote: string; name: string; paramsJson: string } },
    ) => {
      if (win.isDestroyed() || event.senderFrame !== win.webContents.mainFrame)
        return { ok: false, message: 'Smoke window closed' }
      assert.equal(op.input.remote, remote)
      if (op.path === 'cap.names') return { ok: true, data: registry.names('ui', remote) }
      assert.equal(op.path, 'cap.run')
      assert(allowed.has(op.input.name))
      nativeCalls.push(`${currentSub}:${op.input.name}`)
      if (op.input.name === 'google.mailMarkerAnnotations' && failAnnotations-- > 0)
        return { ok: false, message: 'Synthetic marker read failure' }
      try {
        const value = (
          await registry.run(op.input.name, 'ui', context, JSON.parse(op.input.paramsJson ?? '{}'))
        ).value
        if (op.input.name === 'google.mailMarkerAnnotations' && delayNext !== null) {
          const delayed = delayNext
          delayNext = null
          delayed.started()
          await delayed.released
        }
        return { ok: true, data: value }
      } catch (cause) {
        return { ok: false, message: cause instanceof Error ? cause.message : String(cause) }
      }
    },
  )
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('console-message', (event) => {
    console.log(`RENDERER ${event.level}: ${event.message}`)
    if (event.level === 'error') rendererErrors.push(event.message)
  })
  win.webContents.on('render-process-gone', (_event, details) =>
    rendererErrors.push(`renderer process gone: ${details.reason}`),
  )
  win.webContents.on('did-fail-load', (_event, code, description) =>
    rendererErrors.push(`load failed ${code}: ${description}`),
  )
  const js = (code: string) => win.webContents.executeJavaScript(`{ ${code} }`)
  const ready = () =>
    waitFor(
      win,
      `document.querySelector('[aria-label="Enable Red star"]') && document.querySelectorAll('[aria-label="Red star"]').length === 2`,
    )
  const capture = async (name: string) => {
    await pause(250)
    writeFileSync(join(evidence, name), (await win.capturePage()).toPNG())
    captures.push(name)
  }
  await win.loadFile(join(root, 'renderer.html'))
  await ready()
  assert.equal(apiRequests, 0)
  mark('both-production-mail-lists-three-marker-types-and-zero-google-reads')
  const rendererState = await js(
    `({body:document.body.innerText, calls:window.smokeCalls, symbols:[...document.querySelectorAll('[aria-label]')].map(n=>n.getAttribute('aria-label')), sections:[...document.querySelectorAll('section[aria-label]')].map(n=>n.getAttribute('aria-label'))})`,
  )
  assert.equal(await js(`document.querySelectorAll('[aria-label="Starred"]').length`), 2)
  mark('ordinary-external-gmail-stars-retain-ordinary-star')
  let frame = 0
  let recording = false
  const recorder = setInterval(() => {
    if (recording || win.isDestroyed()) return
    recording = true
    void win
      .capturePage()
      .then((image) =>
        writeFileSync(
          join(evidence, 'frames', `frame-${String(frame++).padStart(4, '0')}.png`),
          image.toPNG(),
        ),
      )
      .catch((cause: unknown) => {
        // A reload can replace the capture surface between recording ticks.
        if (!(cause instanceof Error && cause.message === 'UnknownVizError'))
          rendererErrors.push(`Evidence capture failed: ${String(cause)}`)
      })
      .finally(() => {
        recording = false
      })
  }, 200)
  try {
    await capture('connections-before.png')
    for (const name of ['Enable Red star', 'Enable Blue question mark']) {
      await js(`document.querySelector('[aria-label="${name}"]').focus()`)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
      await waitFor(
        win,
        `document.querySelector('[aria-label="${name}"]').getAttribute('aria-checked') === 'true' && !document.querySelector('[aria-label="${name}"]').disabled`,
      )
      await pause(650)
    }
    await js(`document.querySelector('[aria-label="Enable Red star"]').click()`)
    await waitFor(
      win,
      `document.querySelector('[aria-label="Enable Red star"]').getAttribute('aria-checked') === 'false' && !document.querySelector('[aria-label="Enable Red star"]').disabled`,
    )
    await pause(650)
    await js(`document.querySelector('[aria-label="Move Blue question mark up"]').click()`)
    await waitFor(
      win,
      `!document.querySelector('[aria-label="Move Blue question mark down"]').disabled`,
    )
    const expected = { enabledOrder: ['blue-question', 'yellow-star'] }
    assert.deepEqual(await createMailMarkerStore(storeRoot, subA).preferences(), expected)
    assert.deepEqual(await markersA.read(['thread-red']), { 'thread-red': 'red-star' })
    mark('native-keyboard-enable-disable-reorder-persists-through-production-capabilities')
    for (const value of data.values()) value.forget()
    data = new Map([subA, subB].map((sub) => [sub, newData(sub)]))
    await win.loadFile(join(root, 'renderer.html'))
    await ready()
    await waitFor(
      win,
      `document.querySelector('[aria-label="Move Blue question mark up"]').disabled && document.querySelector('[aria-label="Enable Red star"]').getAttribute('aria-checked') === 'false'`,
    )
    assert.deepEqual(await createMailMarkerStore(storeRoot, subA).preferences(), expected)
    mark('production-account-local-marker-store-and-restart-persistence')
    for (const theme of ['light', 'dark']) {
      await js(
        `document.documentElement.setAttribute('data-theme', '${theme}'); window.smokeShow('connections')`,
      )
      await capture(`connections-${theme}.png`)
      for (const view of ['shell', 'surface']) {
        await js(`window.smokeShow('${view}')`)
        await capture(`${view}-${theme}.png`)
      }
    }
    for (const [view, section] of [
      ['shell', 'Production app-shell mail'],
      ['surface', 'Production legacy mail reader'],
    ]) {
      await js(
        `window.smokeShow('${view}'); const scope=document.querySelector('section[aria-label="${section}"]'); const row=[...scope.querySelectorAll('[role="listitem"],button')].find(n=>n.textContent.includes('Red marker fixture')); if(!row)throw Error('Missing reader row'); row.click()`,
      )
      await waitFor(
        win,
        `document.querySelector('section[aria-label="${section}"]').textContent.includes('Synthetic message body for smoke-account-a.')`,
      )
      await waitFor(
        win,
        `document.querySelector('section[aria-label="${section}"]').querySelectorAll('[aria-label="Red star"]').length >= 2`,
      )
      const action = view === 'shell' ? 'Unstar thread' : 'Unstar this thread'
      assert(
        await js(
          `!!document.querySelector('section[aria-label="${section}"] [aria-label="${action}"] [aria-label="Red star"]')`,
        ),
        'reader action must show the actual marker',
      )
      await capture(`${view}-reader-dark.png`)
    }
    mark('both-production-readers-render-stored-marker')
    // Both renderers remain mounted while the account identity changes.
    const switchAccount = async (sub: string) => {
      await registry.run('google.useAccount', 'ui', context, { sub })
      await js('window.smokeRefresh()')
      await waitFor(
        win,
        `document.body.textContent.includes('${sub === subA ? 'account-a' : 'account-b'}@example.test') && document.querySelector('[aria-label="Enable Red star"]')`,
      )
    }
    await switchAccount(subB)
    await waitFor(
      win,
      `document.querySelectorAll('[aria-label="Red star"]').length === 0 && document.querySelectorAll('[aria-label="Blue question mark"]').length === 0 && document.body.textContent.includes('Account B — Red marker fixture')`,
    )
    for (const section of ['Production app-shell mail', 'Production legacy mail reader']) {
      assert(
        await js(
          `const scope=document.querySelector('section[aria-label="${section}"]'); scope.textContent.includes('Account B — Red marker fixture') && !scope.textContent.includes('Account A —') && !scope.textContent.includes('Synthetic message body for smoke-account-a.')`,
        ),
        `${section} must not retain account A mail`,
      )
      await js(
        `const scope=document.querySelector('section[aria-label="${section}"]'); const row=[...scope.querySelectorAll('[role="listitem"],button')].find(n=>n.textContent.includes('Account B — Red marker fixture')); if(!row)throw Error('Missing account B reader row'); row.click()`,
      )
      await waitFor(
        win,
        `document.querySelector('section[aria-label="${section}"]').textContent.includes('Synthetic message body for smoke-account-b.')`,
      )
    }
    assert.deepEqual(await createMailMarkerStore(storeRoot, subB).preferences(), {
      enabledOrder: ['yellow-star'],
    })
    await switchAccount(subA)
    await waitFor(
      win,
      `document.querySelectorAll('[aria-label="Red star"]').length >= 2 && document.body.textContent.includes('Account A — Red marker fixture')`,
    )
    await js(
      `document.querySelector('section[aria-label="Production app-shell mail"] #thread-yellow').click(); document.querySelector('section[aria-label="Production app-shell mail"] #thread-red').click()`,
    )
    await waitFor(
      win,
      `document.querySelector('section[aria-label="Production app-shell mail"]').textContent.includes('Synthetic message body for smoke-account-a.')`,
    )
    mark('account-a-account-b-account-a-isolation')
    failAnnotations = 100
    await win.loadFile(join(root, 'renderer.html'))
    await waitFor(win, `document.querySelectorAll('[aria-label="Retry marker"]').length >= 2`)
    await js(`window.smokeShow('shell')`)
    await capture('marker-error.png')
    win.focus()
    win.webContents.focus()
    await js(
      `window.smokeKeys=[]; document.addEventListener('keydown', event=>window.smokeKeys.push(event.key+':'+event.target.getAttribute('aria-label')), true)`,
    )
    const readerCallsBeforeKeys = await js(
      `window.smokeCalls.filter(call=>call.input?.name==='google.thread' || call.input?.name==='google.mark-read').length`,
    )
    const markerReadsBeforeKeys = await js(
      `window.smokeCalls.filter(call=>call.input?.name==='google.mailMarkerAnnotations').length`,
    )
    await js(
      `document.querySelector('section[aria-label="Production app-shell mail"] [aria-label="Retry marker"]').focus()`,
    )
    await waitFor(win, `document.activeElement?.getAttribute('aria-label') === 'Retry marker'`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await waitFor(win, `window.smokeKeys.length >= 1`)
    await waitFor(
      win,
      `window.smokeCalls.filter(call=>call.input?.name==='google.mailMarkerAnnotations').length >= ${markerReadsBeforeKeys + 1}`,
    )
    await waitFor(
      win,
      `document.querySelector('section[aria-label="Production app-shell mail"]').querySelectorAll('[aria-label="Retry marker"]').length === 4 && document.querySelectorAll('[aria-label="Loading marker"]').length === 0`,
    )
    await js(
      `document.querySelector('section[aria-label="Production app-shell mail"] [aria-label="Retry marker"]').focus()`,
    )
    await waitFor(win, `document.activeElement?.getAttribute('aria-label') === 'Retry marker'`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ' ' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await waitFor(
      win,
      `window.smokeCalls.filter(call=>call.input?.name==='google.mailMarkerAnnotations').length >= ${markerReadsBeforeKeys + 2}`,
    )
    await waitFor(
      win,
      `document.querySelector('section[aria-label="Production app-shell mail"]').querySelectorAll('[aria-label="Retry marker"]').length === 4 && document.querySelectorAll('[aria-label="Loading marker"]').length === 0`,
    )
    assert.equal(
      await js(
        `window.smokeCalls.filter(call=>call.input?.name==='google.thread' || call.input?.name==='google.mark-read').length`,
      ),
      readerCallsBeforeKeys,
    )
    assert.equal(
      await js(
        `document.querySelector('section[aria-label="Production app-shell mail"]').textContent.includes('Synthetic message body for smoke-account-a.')`,
      ),
      false,
    )
    failAnnotations = 0
    await js(`document.querySelectorAll('[aria-label="Retry marker"]').forEach(n=>n.click())`)
    await ready()
    mark('native-enter-space-marker-retry-does-not-open-or-mark-read')
    mark('native-marker-failure-and-retry-recover-both-lists')
    let release!: () => void
    let started!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    delayNext = { started, released: pending }
    await win.loadFile(join(root, 'renderer.html'))
    await entered
    await switchAccount(subB)
    await markersA.set('thread-red', 'blue-question')
    await switchAccount(subA)
    await waitFor(
      win,
      `document.querySelectorAll('[aria-label="Blue question mark"]').length === 4 && document.querySelectorAll('[aria-label="Red star"]').length === 0`,
    )
    release()
    await pause(600)
    assert.equal(await js(`document.querySelectorAll('[aria-label="Red star"]').length`), 0)
    mark('delayed-native-a-b-a-marker-result-does-not-resurrect-old-annotation')
    await markersA.set('thread-red', 'red-star')
    await win.loadFile(join(root, 'renderer.html'))
    await ready()
    await js(
      `window.smokeShow('shell'); document.querySelector('section[aria-label="Production app-shell mail"] #thread-red').click()`,
    )
    await waitFor(
      win,
      `document.querySelector('section[aria-label="Production app-shell mail"]').textContent.includes('Synthetic message body for smoke-account-a.')`,
    )
    const priorRequests = apiRequests
    await js(
      `const scope=document.querySelector('section[aria-label="Production app-shell mail"]'); const unstar=[...scope.querySelectorAll('button')].find(n=>n.getAttribute('aria-label')==='Unstar thread' || n.textContent==='Unstar'); if(!unstar)throw Error('Missing unstar action'); unstar.click()`,
    )
    await waitFor(
      win,
      `document.querySelector('section[aria-label="Production app-shell mail"]').querySelectorAll('[aria-label="Red star"]').length === 0`,
    )
    assert(apiRequests > priorRequests)
    assert.deepEqual(await createMailMarkerStore(storeRoot, subA).read(['thread-red']), {
      'thread-red': null,
    })
    mark('native-boolean-unstar-uses-production-capability-and-clears-annotation')
    mark('native-electron-production-connections-section-mounted')
    assert.deepEqual(rendererErrors, [])
    assert.deepEqual(await js('window.smokeErrors ?? []'), [])
    assert.deepEqual(denied, [])
    assert(nativeCalls.some((name) => name.endsWith(':google.setMailMarkerPreferences')))
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
          networkDenied: denied,
          isolatedRoots: {
            userData: storeRoot,
            appData: join(root, 'app-data'),
            sessionData: join(root, 'session-data'),
            vault: vaultRoot,
          },
          captures,
          rendererText: rendererState.body,
          rendererCalls: rendererState.calls,
          nativeCalls,
          apiRequests,
          rendererErrors,
          mountedSections: rendererState.sections,
          rendererSymbols: rendererState.symbols,
        },
        null,
        2,
      ),
    )
  } finally {
    clearInterval(recorder)
    while (recording) await pause(20)
  }
  win.destroy()
  app.quit()
}

void run().catch((error: unknown) => {
  console.error(error)
  for (const win of BrowserWindow.getAllWindows()) win.destroy()
  app.exit(1)
})
