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

const root = process.env.HOLI_464_ROOT!
const evidence = process.env.HOLI_464_EVIDENCE!
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
  app.setName('Holi mail markers smoke 464')
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
    'google.setMailMarker',
    'google.mailMarkerAnnotations',
    'google.star',
    'google.search',
    'google.mark-read',
    'google.imageSenders',
  ])
  let failAnnotations = 0
  const fakeStarred = new Set(['thread-yellow', 'thread-red', 'thread-blue'])
  const refusedUnstars = new Set<string>()
  let delayNext: null | { started: () => void; released: Promise<void> } = null
  let holdSecondMarkerRead: {
    id: string
    reads: number
    started: () => void
    released: Promise<void>
  } | null = null
  const refusedUnstarCalls: string[] = []
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
        const params = JSON.parse(op.input.paramsJson ?? '{}') as Record<string, unknown>
        if (op.input.name === 'google.setMailMarker') {
          const id = String(params.id)
          if (params.marker === null && refusedUnstars.has(id)) {
            refusedUnstarCalls.push(id)
            return { ok: false, message: 'Synthetic Gmail unstar refusal' }
          }
          if (params.marker === null) fakeStarred.delete(id)
          else fakeStarred.add(id)
        }
        if (op.input.name === 'google.star') {
          const id = String(params.id)
          if (params.off === true && refusedUnstars.has(id)) {
            // Gmail refused the unstar: preserve its actual starred state.
          } else if (params.off === true) fakeStarred.delete(id)
          else fakeStarred.add(id)
        }
        if (op.input.name === 'google.search' && params.query === 'is:starred') {
          return {
            ok: true,
            data: { threads: [...fakeStarred].map((id) => ({ id })), nextPageToken: null },
          }
        }
        const value = (await registry.run(op.input.name, 'ui', context, params)).value
        if (op.input.name === 'google.mailMarkerAnnotations') {
          if (
            holdSecondMarkerRead !== null &&
            Array.isArray(params.ids) &&
            params.ids.includes(holdSecondMarkerRead.id)
          ) {
            const delayed = holdSecondMarkerRead
            delayed.reads++
            if (delayed.reads === 2) {
              holdSecondMarkerRead = null
              delayed.started()
              await delayed.released
            }
          }
          if (delayNext !== null) {
            const delayed = delayNext
            delayNext = null
            delayed.started()
            await delayed.released
          }
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
  const nativeClick = async (selector: string) => {
    await waitFor(
      win,
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return !!r&&r.width>0&&r.height>0})()`,
    )
    const point = await js(
      `const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); if(!r||r.width===0||r.height===0)throw Error('Missing visible native click target: '+${JSON.stringify(selector)}); ({x:r.x+r.width/2,y:r.y+r.height/2})`,
    )
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    })
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    })
  }
  const nativeClickLast = async (selector: string) => {
    await waitFor(
      win,
      `(()=>{const target=[...document.querySelectorAll(${JSON.stringify(selector)})].at(-1); const r=target?.getBoundingClientRect(); return !!target&&!!r&&r.width>0&&r.height>0})()`,
    )
    const point = await js(
      `const target=[...document.querySelectorAll(${JSON.stringify(selector)})].at(-1); target.scrollIntoView({block:'center',inline:'center'}); const r=target.getBoundingClientRect(); ({x:r.x+r.width/2,y:r.y+r.height/2})`,
    )
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    })
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    })
  }
  const nativeClickSequence = async (selector: string, count: number) => {
    await waitFor(
      win,
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return !!r&&r.width>0&&r.height>0})()`,
    )
    const point = await js(
      `const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); if(!r||r.width===0||r.height===0)throw Error('Missing visible native click target: '+${JSON.stringify(selector)}); ({x:r.x+r.width/2,y:r.y+r.height/2})`,
    )
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    for (let index = 0; index < count; index++) {
      win.webContents.sendInputEvent({
        type: 'mouseDown',
        x: point.x,
        y: point.y,
        button: 'left',
        clickCount: 1,
      })
      win.webContents.sendInputEvent({
        type: 'mouseUp',
        x: point.x,
        y: point.y,
        button: 'left',
        clickCount: 1,
      })
    }
  }
  const installTrustedClickRecorder = () =>
    js(
      `window.smokeTrustedClicks=[]; document.addEventListener('click', event=>{const target=event.target instanceof Element ? event.target.closest('[aria-label="Star thread"],[aria-label="Unstar thread"],[aria-label="Unstar this thread"]') : null; if(target)window.smokeTrustedClicks.push({at:event.timeStamp,trusted:event.isTrusted,label:target.getAttribute('aria-label')})},true)`,
    )
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
  await waitFor(win, `document.querySelectorAll('[aria-label="Yellow star"]').length === 2`)
  await installTrustedClickRecorder()
  assert.equal(apiRequests, 0)
  mark('both-production-mail-lists-three-marker-types-and-zero-google-reads')
  const rendererState = await js(
    `({body:document.body.innerText, calls:window.smokeCalls, symbols:[...document.querySelectorAll('[aria-label]')].map(n=>n.getAttribute('aria-label')), sections:[...document.querySelectorAll('section[aria-label]')].map(n=>n.getAttribute('aria-label'))})`,
  )
  assert.equal(await js(`document.querySelectorAll('[aria-label="Starred"]').length`), 2)
  mark('ordinary-external-gmail-stars-retain-ordinary-star')
  for (const [view, section, id] of [
    ['shell', 'Production app-shell mail', 'thread-unstarred-shell'],
    ['surface', 'Production legacy mail reader', 'thread-unstarred-surface'],
  ] as const) {
    await markersA.set(id, 'blue-question')
    fakeStarred.delete(id)
    await win.loadFile(join(root, 'renderer.html'))
    await waitFor(
      win,
      `document.querySelector('[aria-label="Enable Red star"]') && document.querySelector('section[aria-label="${section}"] #${id} [aria-label="Star thread"]')`,
    )
    await installTrustedClickRecorder()
    await js(`window.smokeShow('${view}')`)
    const expectedMarker = (await markersA.preferences()).enabledOrder[0]!
    const writesBefore = await js(
      `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length`,
    )
    await nativeClick(`section[aria-label="${section}"] #${id} [aria-label="Star thread"]`)
    await waitFor(
      win,
      `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length > ${writesBefore}`,
    )
    assert.deepEqual(await markersA.read([id]), { [id]: expectedMarker })
    await markersA.set(id, null)
    fakeStarred.delete(id)
  }
  mark('native-stale-annotation-does-not-prevent-first-star-in-both-mail-lists')
  await win.loadFile(join(root, 'renderer.html'))
  await waitFor(win, `document.querySelector('[aria-label="Enable Red star"]')`)
  await installTrustedClickRecorder()
  for (const [view, section, id] of [
    ['shell', 'Production app-shell mail', 'thread-unstarred-shell'],
    ['surface', 'Production legacy mail reader', 'thread-unstarred-surface'],
  ] as const) {
    await js(`window.smokeShow('${view}')`)
    await pause(150)
    const selector = `section[aria-label="${section}"] #${id} [aria-label="Star thread"]`
    const writesBefore = await js(
      `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length`,
    )
    const markerEventStart = await js('window.smokeTrustedClicks.length')
    await nativeClick(selector)
    await waitFor(
      win,
      `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length > ${writesBefore}`,
    )
    await waitFor(
      win,
      `document.querySelector('section[aria-label="${section}"] #${id} [aria-label="Yellow star"]')`,
    )
    assert.deepEqual(await markersA.read([id]), { [id]: 'yellow-star' })
    await pause(550)
    const unstarWritesBefore = await js(
      `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length`,
    )
    await nativeClick(selector.replace('Star thread', 'Unstar thread'))
    await waitFor(
      win,
      `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length > ${unstarWritesBefore}`,
    )
    await waitFor(
      win,
      `document.querySelector('section[aria-label="${section}"] #${id} [aria-label="Star thread"]')`,
    )
    const delayedEvents = await js(`window.smokeTrustedClicks.slice(${markerEventStart})`)
    assert.equal(delayedEvents.length, 2)
    assert(delayedEvents.every((event: { trusted: boolean }) => event.trusted))
    assert(
      delayedEvents[1]!.at - delayedEvents[0]!.at > 500,
      'single-marker unstar must follow a trusted click more than 500ms later',
    )
    assert.deepEqual(await markersA.read([id]), { [id]: null })
  }
  mark('native-single-marker-star-then-delayed-unstar-in-both-mail-surfaces')
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
    await js(`window.smokeShow('connections')`)
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
    await js(`document.querySelector('[aria-label="Move Blue question mark up"]').click()`)
    await pause(100)
    await js(`document.querySelector('[aria-label="Move Blue question mark up"]').click()`)
    await waitFor(
      win,
      `document.querySelector('[aria-label="Move Blue question mark up"]').disabled && !document.querySelector('[aria-label="Move Blue question mark down"]').disabled`,
    )
    const expected = { enabledOrder: ['blue-question', 'yellow-star', 'red-star'] }
    assert.deepEqual(await createMailMarkerStore(storeRoot, subA).preferences(), expected)
    assert.deepEqual(await markersA.read(['thread-red']), { 'thread-red': 'red-star' })
    mark('native-keyboard-enable-disable-reorder-persists-through-production-capabilities')
    for (const [view, section, id] of [
      ['shell', 'Production app-shell mail', 'thread-unstarred-shell'],
      ['surface', 'Production legacy mail reader', 'thread-unstarred-surface'],
    ] as const) {
      await js(`window.smokeShow('${view}')`)
      const selector = `section[aria-label="${section}"] #${id} [aria-label="Star thread"]`
      await nativeClick(selector)
      await waitFor(
        win,
        `document.querySelector('section[aria-label="${section}"] #${id} [aria-label="Blue question mark"]')`,
      )
      assert.deepEqual(await markersA.read([id]), { [id]: 'blue-question' })
      await markersA.set(id, null)
      fakeStarred.delete(id)
    }
    mark('mounted-mail-surfaces-observe-preference-reorder-without-remount')
    for (const value of data.values()) value.forget()
    data = new Map([subA, subB].map((sub) => [sub, newData(sub)]))
    await win.loadFile(join(root, 'renderer.html'))
    await ready()
    await installTrustedClickRecorder()
    await waitFor(
      win,
      `document.querySelector('[aria-label="Move Blue question mark up"]').disabled && document.querySelector('[aria-label="Enable Red star"]').getAttribute('aria-checked') === 'true'`,
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
    ] as const) {
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
      const readerAction = `section[aria-label="${section}"] button[aria-label="${action}"]`
      const markerWrites = await js(
        `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length`,
      )
      await nativeClickLast(readerAction)
      await waitFor(
        win,
        `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length > ${markerWrites}`,
      )
      assert.deepEqual(await markersA.read(['thread-red']), { 'thread-red': null })
      await markersA.set('thread-red', 'red-star')
    }
    mark('both-production-readers-render-and-natively-unstar-stored-marker')
    await registry.run('google.useAccount', 'ui', context, { sub: subB })
    const accountB = await registry.run('google.status', 'ui', context, {})
    assert(accountB.value && typeof accountB.value === 'object' && 'account' in accountB.value)
    assert.deepEqual(accountB.value.account, sessions.get(subB)!.account)
    assert.deepEqual(await createMailMarkerStore(storeRoot, subB).preferences(), {
      enabledOrder: ['yellow-star'],
    })
    await registry.run('google.useAccount', 'ui', context, { sub: subA })
    const accountA = await registry.run('google.status', 'ui', context, {})
    assert(accountA.value && typeof accountA.value === 'object' && 'account' in accountA.value)
    assert.deepEqual(accountA.value.account, sessions.get(subA)!.account)
    assert.deepEqual(await markersA.preferences(), {
      enabledOrder: ['blue-question', 'yellow-star', 'red-star'],
    })
    mark('native-account-context-switch-and-marker-store-isolation')
    for (const [view, section, id] of [
      ['shell', 'Production app-shell mail', 'thread-unstarred-shell'],
      ['surface', 'Production legacy mail reader', 'thread-unstarred-surface'],
    ] as const) {
      await js(`window.smokeShow('${view}')`)
      const cycleSelector = `section[aria-label="${section}"] #${id} [aria-label="Star thread"]`
      const cycleStart = await js('window.smokeTrustedClicks.length')
      await nativeClickSequence(cycleSelector, 4)
      await waitFor(
        win,
        `document.querySelector('section[aria-label="${section}"] #${id} [aria-label="Blue question mark"]')`,
      )
      const trusted = await js(`window.smokeTrustedClicks.slice(${cycleStart})`)
      assert.equal(trusted.length, 4)
      assert(trusted.every((event: { trusted: boolean }) => event.trusted))
      assert(
        trusted.at(-1)!.at - trusted[0]!.at < 500,
        'native cycle must fit inside the 500ms burst',
      )
      assert.deepEqual(await markersA.read([id]), { [id]: 'blue-question' })
      await pause(550)
      await nativeClick(`section[aria-label="${section}"] #${id} [aria-label="Unstar thread"]`)
      await waitFor(
        win,
        `document.querySelector('section[aria-label="${section}"] #${id} [aria-label="Star thread"]')`,
      )
      await js(`window.smokeShow('${view}')`)
      await pause(400)
      const actionCalls = await js(
        `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length`,
      )
      const readerCalls = await js(
        `window.smokeCalls.filter(call=>call.input?.name==='google.thread' || call.input?.name==='google.mark-read').length`,
      )
      await nativeClick(`section[aria-label="${section}"] #${id} [aria-label="Star thread"]`)
      await waitFor(
        win,
        `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length > ${actionCalls} && document.querySelector('section[aria-label="${section}"] #${id} [aria-pressed="true"]')`,
      )
      assert.equal(
        await js(
          `window.smokeCalls.filter(call=>call.input?.name==='google.thread' || call.input?.name==='google.mark-read').length`,
        ),
        readerCalls,
        'a marker action must not open the thread or mark it read',
      )
      assert(
        await js(
          `!!document.querySelector('section[aria-label="${section}"] #${id} [aria-label="Blue question mark"]')`,
        ),
        `${section} must render the configured marker glyph`,
      )
      for (const theme of ['light', 'dark']) {
        await js(`document.documentElement.setAttribute('data-theme', '${theme}')`)
        await capture(`${view}-marker-action-${theme}.png`)
      }
    }
    mark('native-four-click-production-cycle-wraps-through-configured-markers')
    mark('both-production-mail-lists-star-without-opening-or-marking-read')

    // Exercise reader-header annotation recovery after a marker write while
    // the thread remains open. The write succeeds; only its reconciliation read fails.
    for (const [view, section, id] of [
      ['shell', 'Production app-shell mail', 'thread-unstarred-shell'],
      ['surface', 'Production legacy mail reader', 'thread-unstarred-surface'],
    ] as const) {
      await markersA.set(id, null)
      fakeStarred.delete(id)
      await win.loadFile(join(root, 'renderer.html'))
      await waitFor(
        win,
        `document.querySelector('[aria-label="Enable Red star"]') && document.querySelector('section[aria-label="${section}"] #${id}')`,
      )
      await waitFor(
        win,
        `document.querySelector('[aria-label="Enable Blue question mark"][aria-checked="true"]') && document.querySelectorAll('[aria-label="Blue question mark"]').length === 2 && !document.querySelector('[aria-label="Loading marker"]')`,
      )
      await installTrustedClickRecorder()
      await js(`window.smokeShow('${view}')`)
      const row = `section[aria-label="${section}"] #${id}`
      await nativeClick(row)
      const readerAction =
        view === 'shell'
          ? `section[aria-label="${section}"] [role="toolbar"][aria-label="Thread actions"] button[aria-label="Star thread"]`
          : `section[aria-label="${section}"] button[aria-label="Star this thread"]`
      await waitFor(
        win,
        `document.querySelector('section[aria-label="${section}"]').textContent.includes('Synthetic message body for smoke-account-a.') && document.querySelector(${JSON.stringify(readerAction)})`,
      )
      await waitFor(
        win,
        `document.querySelector(${JSON.stringify(readerAction)}) && !document.querySelector('section[aria-label="${section}"] [aria-label="Loading marker"]')`,
      )
      const expectedMarker = (await markersA.preferences()).enabledOrder[0]!
      const headerAction = readerAction
      const writesBefore = await js(
        `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length`,
      )
      failAnnotations = 1
      await nativeClick(headerAction)
      await waitFor(
        win,
        `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length > ${writesBefore} && (()=>{const scope=document.querySelector('section[aria-label="${section}"]'); const heading=[...scope.querySelectorAll('h3')].find(node=>node.textContent.includes('Unstarred')); if(!heading)return false; let parent=heading.parentElement; while(parent&&parent!==scope){const retry=parent.querySelector('[aria-label="Retry marker"]'); if(retry){retry.setAttribute('data-smoke-target','reader-retry');return true} parent=parent.parentElement} return false})()`,
      )
      const actionCall = await js(
        `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').at(-1)?.input`,
      )
      assert.deepEqual(JSON.parse(actionCall.paramsJson), {
        id,
        marker: expectedMarker,
        expectedAccountSub: subA,
      })
      assert.deepEqual(await markersA.read([id]), { [id]: expectedMarker })
      failAnnotations = 0
      const headerRetry = `section[aria-label="${section}"] [data-smoke-target="reader-retry"]`
      await nativeClick(headerRetry)
      const markerLabel =
        expectedMarker === 'blue-question'
          ? 'Blue question mark'
          : expectedMarker === 'red-star'
            ? 'Red star'
            : 'Yellow star'
      const starredHeader =
        view === 'shell'
          ? `section[aria-label="${section}"] [role="toolbar"][aria-label="Thread actions"] button[aria-label="Unstar thread"][aria-pressed="true"] [aria-label="${markerLabel}"]`
          : `section[aria-label="${section}"] button[aria-label="Unstar this thread"] [aria-label="${markerLabel}"]`
      await waitFor(
        win,
        `!document.querySelector('section[aria-label="${section}"] [data-smoke-target="reader-retry"]') && document.querySelector(${JSON.stringify(starredHeader)})`,
      )
      assert.deepEqual(await markersA.read([id]), { [id]: expectedMarker })
      await markersA.set(id, null)
      fakeStarred.delete(id)
    }
    mark('native-reader-header-retry-recovers-action-reconciliation-in-both-surfaces')

    const listId = 'thread-red'
    await markersA.set(listId, null)
    fakeStarred.add(listId)
    refusedUnstars.add(listId)
    failAnnotations = 0
    await win.loadFile(join(root, 'renderer.html'))
    await waitFor(
      win,
      `document.querySelector('[aria-label="Enable Red star"]') && document.querySelector('section[aria-label="Production app-shell mail"] #${listId} [aria-label="Unstar thread"]')`,
    )
    await installTrustedClickRecorder()
    await js(`window.smokeShow('shell')`)
    await waitFor(win, `document.querySelectorAll('[aria-label="Loading marker"]').length === 0`)
    failAnnotations = 1
    const listWritesBefore = await js(
      `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length`,
    )
    const refusedListBefore = refusedUnstarCalls.length
    await nativeClick(
      `section[aria-label="Production app-shell mail"] #${listId} [aria-label="Unstar thread"]`,
    )
    await waitFor(
      win,
      `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length > ${listWritesBefore} && document.querySelector('section[aria-label="Production app-shell mail"] #${listId} [aria-label="Retry marker"]')`,
    )
    assert.equal(refusedUnstarCalls.length, refusedListBefore + 1)
    const listRetryWrites = await js(
      `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length`,
    )
    await nativeClick(
      `section[aria-label="Production app-shell mail"] #${listId} [aria-label="Retry marker"]`,
    )
    await waitFor(
      win,
      `!document.querySelector('section[aria-label="Production app-shell mail"] #${listId} [aria-label="Retry marker"]')`,
    )
    assert.equal(
      await js(`window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length`),
      listRetryWrites,
      'list Retry must reconcile without replaying the refused unstar',
    )
    assert.equal(fakeStarred.has(listId), true)
    refusedUnstars.delete(listId)
    await markersA.set(listId, 'red-star')
    failAnnotations = 0
    mark('native-shell-list-retry-recovers-refused-unstar-without-replay')

    // Gmail refuses both reader implementations' unstar writes. The personal marker
    // remains absent while the synthetic Gmail summary remains starred.
    for (const [view, section, unstarLabel] of [
      ['shell', 'Production app-shell mail', 'Unstar thread'],
      ['surface', 'Production legacy mail reader', 'Unstar this thread'],
    ] as const) {
      const id = 'thread-red'
      await markersA.set(id, null)
      fakeStarred.add(id)
      refusedUnstars.add(id)
      const refusedBefore = refusedUnstarCalls.length
      await win.loadFile(join(root, 'renderer.html'))
      await waitFor(
        win,
        `document.querySelector('[aria-label="Enable Red star"]') && document.querySelector('section[aria-label="${section}"] #${id}')`,
      )
      await installTrustedClickRecorder()
      await js(`window.smokeShow('${view}')`)
      await nativeClick(`section[aria-label="${section}"] #${id}`)
      await waitFor(
        win,
        `document.querySelector('section[aria-label="${section}"]').textContent.includes('Synthetic message body for smoke-account-a.')`,
      )
      const headerAction =
        view === 'shell'
          ? `section[aria-label="${section}"] [role="toolbar"][aria-label="Thread actions"] button[aria-label="Unstar thread"]`
          : `section[aria-label="${section}"] button[aria-label="Unstar this thread"]`
      await waitFor(win, `document.querySelectorAll(${JSON.stringify(headerAction)}).length === 1`)
      const writesBefore = await js(
        `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length`,
      )
      const searchesBefore = await js(
        `window.smokeCalls.filter(call=>call.input?.name==='google.search' && JSON.parse(call.input.paramsJson).query==='is:starred').length`,
      )
      const pressedSelector = `${headerAction}${view === 'shell' ? '[aria-pressed="true"]' : ''}`
      failAnnotations = 1
      await nativeClick(pressedSelector)
      await waitFor(
        win,
        `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length > ${writesBefore} && document.querySelector('section[aria-label="${section}"] [aria-label="Retry marker"]')`,
      )
      assert.equal(
        await js(
          `!document.querySelector(${JSON.stringify(headerAction)})?.querySelector('[aria-label="Starred"]')`,
        ),
        true,
        `${view} unstarred error must not render a filled Starred glyph`,
      )
      const retryWrites = await js(
        `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length`,
      )
      await nativeClick(`section[aria-label="${section}"] [aria-label="Retry marker"]`)
      await waitFor(
        win,
        `!document.querySelector('section[aria-label="${section}"] [aria-label="Retry marker"]')`,
      )
      assert.equal(
        await js(
          `window.smokeCalls.filter(call=>call.input?.name==='google.setMailMarker').length`,
        ),
        retryWrites,
        'Retry must reconcile without replaying the refused unstar',
      )
      assert.equal(id, 'thread-red', 'Gmail still owns the actual starred membership')
      assert.equal(refusedUnstarCalls.length, refusedBefore + 1)
      assert.equal(refusedUnstarCalls.at(-1), id)
      await waitFor(
        win,
        `window.smokeCalls.filter(call=>call.input?.name==='google.search' && JSON.parse(call.input.paramsJson).query==='is:starred').length > ${searchesBefore}`,
      )
      assert.equal(id, 'thread-red', 'the synthetic Gmail summary is already starred')
      assert.deepEqual(await markersA.read([id]), { [id]: null })
      assert.equal(
        await js(
          `(()=>{const action=document.querySelector(${JSON.stringify(headerAction)}); const glyph=action?.querySelector('[aria-label="Starred"]'); return action?.getAttribute('aria-label')===${JSON.stringify(unstarLabel)} && ${view === 'shell' ? `action.getAttribute('aria-pressed')==='true'` : '!!glyph'}})()`,
        ),
        true,
        `${view} reader must preserve its actual starred state after refusal`,
      )
      refusedUnstars.delete(id)
      await markersA.set(id, 'red-star')
    }
    mark('native-refused-unstar-error-retries-reconciliation-without-replay')
    mark('native-reader-retains-unstar-state-after-refused-gmail-unstar')

    // Hold the second annotation read (the display hook's reload) after the
    // controller's reconciliation read has completed.
    const burstId = 'thread-unstarred-shell'
    await markersA.set(burstId, null)
    fakeStarred.delete(burstId)
    let releaseMarkerRead!: () => void
    let markerReadStarted!: () => void
    const heldMarkerRead = new Promise<void>((resolve) => {
      releaseMarkerRead = resolve
    })
    const markerReadEntered = new Promise<void>((resolve) => {
      markerReadStarted = resolve
    })
    let markerReadReleased = false
    const waitForStoredMarker = async (expected: string) => {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if ((await markersA.read([burstId]))[burstId] === expected) return
        await pause(20)
      }
      assert.equal((await markersA.read([burstId]))[burstId], expected)
    }
    try {
      await win.loadFile(join(root, 'renderer.html'))
      await waitFor(
        win,
        `document.querySelector('[aria-label="Enable Red star"]') && document.querySelector('section[aria-label="Production app-shell mail"] #${burstId}')`,
      )
      await installTrustedClickRecorder()
      await js(`window.smokeShow('shell')`)
      await pause(150)
      holdSecondMarkerRead = {
        id: burstId,
        reads: 0,
        started: markerReadStarted,
        released: heldMarkerRead,
      }
      const cycle = `section[aria-label="Production app-shell mail"] #${burstId} button[aria-label="Star thread"], section[aria-label="Production app-shell mail"] #${burstId} button[aria-label="Unstar thread"]`
      const burstStart = await js('window.smokeTrustedClicks.length')
      await nativeClick(cycle)
      await markerReadEntered
      assert.equal(holdSecondMarkerRead, null, 'the second annotation read is held')
      const configured = (await markersA.preferences()).enabledOrder
      const firstExpected = configured[0]!
      const secondExpected = configured[1]!
      await waitForStoredMarker(firstExpected)
      assert.equal((await markersA.read([burstId]))[burstId], firstExpected)
      await nativeClick(cycle)
      const burstEvents = await js(`window.smokeTrustedClicks.slice(${burstStart})`)
      assert.equal(burstEvents.length, 2)
      assert(burstEvents.every((event: { trusted: boolean }) => event.trusted))
      assert(burstEvents[1]!.at - burstEvents[0]!.at <= 500)
      await waitForStoredMarker(secondExpected)
      assert.equal((await markersA.read([burstId]))[burstId], secondExpected)
    } finally {
      if (!markerReadReleased) {
        releaseMarkerRead()
        markerReadReleased = true
      }
      holdSecondMarkerRead = null
      await markersA.set(burstId, null)
      fakeStarred.delete(burstId)
    }
    mark('native-shell-click-during-secondary-refetch-advances-marker-sequence')
    failAnnotations = 100
    await win.loadFile(join(root, 'renderer.html'))
    await waitFor(win, `document.querySelectorAll('[aria-label="Retry marker"]').length >= 2`)
    await installTrustedClickRecorder()
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
      `document.querySelector('section[aria-label="Production app-shell mail"]').querySelectorAll('[aria-label="Retry marker"]').length >= 4 && document.querySelectorAll('[aria-label="Loading marker"]').length === 0`,
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
      `document.querySelector('section[aria-label="Production app-shell mail"]').querySelectorAll('[aria-label="Retry marker"]').length >= 4 && document.querySelectorAll('[aria-label="Loading marker"]').length === 0`,
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
    for (let attempt = 0; attempt < 8; attempt++) {
      const retries = await js(`document.querySelectorAll('[aria-label="Retry marker"]').length`)
      if (retries === 0) break
      await js(`document.querySelector('[aria-label="Retry marker"]')?.click()`)
      await pause(50)
    }
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
    const switchAccount = async (sub: string) => {
      await registry.run('google.useAccount', 'ui', context, { sub })
      await js('window.smokeRefresh()')
      await waitFor(
        win,
        `document.body.textContent.includes('${sub === subA ? 'account-a' : 'account-b'}@example.test')`,
      )
    }
    await win.loadFile(join(root, 'renderer.html'))
    await entered
    await installTrustedClickRecorder()
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
    await installTrustedClickRecorder()
    await js(
      `window.smokeShow('shell'); document.querySelector('section[aria-label="Production app-shell mail"] #thread-red').click()`,
    )
    await waitFor(
      win,
      `document.querySelector('section[aria-label="Production app-shell mail"]').textContent.includes('Synthetic message body for smoke-account-a.')`,
    )
    const priorRequests = apiRequests
    await js(
      `const scope=document.querySelector('section[aria-label="Production app-shell mail"]'); const unstar=scope.querySelector('[aria-label="Unstar thread"] [aria-label="Red star"]')?.closest('button'); if(!unstar)throw Error('Missing reader unstar action'); unstar.click()`,
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
