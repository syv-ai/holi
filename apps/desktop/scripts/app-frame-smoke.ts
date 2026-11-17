import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, ipcMain, protocol, session, webContents } from 'electron'
import { VAULT_SETTING_DEFAULTS, vaultRelPath } from '@holi/shared'
import { cap } from '../src/main/plugin-api'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import { createCapabilityRegistry } from '../src/main/capabilities/registry'
import { noCoreServices } from '../src/main/capabilities/services'
import { createAppFrameLeases } from '../src/main/plugin-host/app-frame-leases'
import { trackAppFrameDocuments } from '../src/main/plugin-host/app-frame-navigation'
import { createNativeRequestWindows } from '../src/main/plugin-host/native-request-windows'
import { createPluginHost, type OpenVault } from '../src/main/plugin-host/host'
import { serveScheme } from '../src/main/plugin-host/schemes'
import { appsMain } from '../src/plugins/apps/main'
import { appScheme } from '../src/plugins/apps/main/protocol'
import { appHost, appLeaseFromHost, leasedAppHost } from '../src/plugins/apps/shared/bundle'
import type { RendererFixtureMarker } from './app-frame-renderer-fixture'

const bundle = 'Same/Tool.app'
const rootForRemote = (remote: string): string | null =>
  remote === 'ada/a'
    ? join(process.env.HOLI_473_ROOT!, 'vault-a')
    : remote === 'ada/b'
      ? join(process.env.HOLI_473_ROOT!, 'vault-b')
      : null
protocol.registerSchemesAsPrivileged([{ scheme: 'holi-app', privileges: appScheme.privileges }])

/** Exercises the production app scheme and lease authority in an actual Electron frame. */
export async function runAppFrameSmoke(root: string, evidence: string): Promise<string[]> {
  const fixtureMarker: RendererFixtureMarker | undefined = undefined
  void fixtureMarker
  const roots = { A: join(root, 'vault-a'), B: join(root, 'vault-b') }
  for (const [owner, vaultRoot] of Object.entries(roots)) {
    mkdirSync(join(vaultRoot, bundle, 'nested'), { recursive: true })
    mkdirSync(join(vaultRoot, '.holi/settings'), { recursive: true })
    writeFileSync(join(vaultRoot, '.holi/settings/plugins.yaml'), 'plugins:\n  apps: true\n')
    const color = owner === 'A' ? '#b42318' : '#175cd3'
    writeFileSync(
      join(vaultRoot, bundle, 'index.html'),
      `<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><h1 id="owner">owner-${owner}</h1><img id="image" src="./nested/pixel.svg"><pre id="bridge-read-result">waiting</pre><script src="/owner.js"></script><script src="/bridge.js"></script></body></html>`,
    )
    writeFileSync(join(vaultRoot, 'note.md'), `# Vault ${owner} note\nowned-${owner.toLowerCase()}`)
    writeFileSync(
      join(vaultRoot, bundle, 'bridge.js'),
      `addEventListener('message',event=>{if(event.data?.kind==='fixture-stale')parent.postMessage({id:'stale-native',method:'docs.read',params:{path:'note.md'},nonce:event.data.nonce},'*');if(event.data?.id==='stale-native')parent.postMessage({kind:'stale-result',value:event.data.value},'*')});window.holi.docs.read('note.md').then(text=>{document.querySelector('#bridge-read-result').textContent=text;parent.postMessage({kind:'bridge-read-result',text,owner:'${owner}',nonce:document.querySelector('meta[name=holi-app-document-nonce]').content},'*')},error=>{document.querySelector('#bridge-read-result').textContent='ERROR '+error})`,
    )
    writeFileSync(
      join(vaultRoot, bundle, 'app.yaml'),
      'commands:\n  smoke: { script: command.js }\n',
    )
    writeFileSync(
      join(vaultRoot, bundle, 'owner.js'),
      `document.body.dataset.owner='${owner}';const image=document.querySelector('#image');image.addEventListener('load',()=>parent.postMessage({kind:'app-smoke',value:{owner:document.body.dataset.owner,text:document.querySelector('#owner').textContent,color:getComputedStyle(document.body).color,image:image.naturalWidth,nonce:document.querySelector('meta[name=holi-app-document-nonce]').content,bridge:typeof window.holi?.docs?.read}},'*'),{once:true});if(image.complete)image.dispatchEvent(new Event('load'))`,
    )
    writeFileSync(
      join(vaultRoot, bundle, 'command.js'),
      `document.documentElement.dataset.commandRegistered='true';window.holi.command(input=>({owner:'${owner}',text:input.text,registered:document.documentElement.dataset.commandRegistered==='true'}))`,
    )
    writeFileSync(
      join(vaultRoot, bundle, 'style.css'),
      `@import './nested/inner.css'; body{color:${color}}`,
    )
    writeFileSync(join(vaultRoot, bundle, 'nested/inner.css'), 'h1{font-size:34px}')
    writeFileSync(
      join(vaultRoot, bundle, 'nested/pixel.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${color}"/></svg>`,
    )
  }

  const appFrames = createAppFrameLeases()
  let observedToken: string | null = null
  let revokedBeforeSvgScript = false
  const stopObservingRevocations = appFrames.onRevoke((token) => {
    if (token === observedToken) revokedBeforeSvgScript = true
  })
  let appCallCount = 0
  let docsReadCount = 0
  let fixtureLease: { token: string; nonce: string } | null = null
  let docsReadGate: { entered(): void; wait: Promise<void>; release(): void } | undefined
  let captureGate:
    { entered(): void; wait: Promise<void>; release(): void; used: boolean } | undefined
  const captureResults: boolean[] = []
  const waitForCaptureResult = async (after: number, expected: boolean): Promise<void> => {
    const until = Date.now() + 8_000
    while (!captureResults.slice(after).includes(expected)) {
      if (Date.now() >= until) throw new Error(`capture result ${expected} timed out`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  const registry = createCapabilityRegistry()
  registry.register(['docs'], {
    'docs.read': cap({
      doors: ['app'],
      params: (raw) => ({ path: (raw as { path: string }).path }),
      run: async (ctx, { path }) => {
        docsReadCount += 1
        const gate = docsReadGate
        if (gate) {
          docsReadGate = undefined
          gate.entered()
          await gate.wait
        }
        return readFileSync(join(ctx.root, vaultRelPath(path)), 'utf8')
      },
    }),
  })
  let active: OpenVault | null = null
  let currentWindow: BrowserWindow
  let host!: ReturnType<typeof createPluginHost>
  const capabilityHost = createCapabilityHost({
    registry,
    rootFor: async (remote) => rootForRemote(remote),
    active: () => null,
    core: noCoreServices,
    pluginEnabled: async (plugin, vaultRoot) => (await host.serving(vaultRoot)).has(plugin),
    claims: async () => [],
  })
  const win = new BrowserWindow({
    width: 850,
    height: 650,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  currentWindow = win
  const stopFrameTracking = trackAppFrameDocuments({
    contents: win.webContents,
    window: win,
    leases: appFrames,
    tokenFromUrl: (url) => {
      try {
        const parsed = new URL(url)
        return parsed.protocol === 'holi-app:'
          ? (appLeaseFromHost(parsed.hostname)?.token ?? null)
          : null
      } catch {
        return null
      }
    },
  })
  const windowForRequest = createNativeRequestWindows({
    webRequest: session.defaultSession.webRequest,
    contentsForId: (id) => webContents.fromId(id),
    windowForContents: (contents) => BrowserWindow.fromWebContents(contents),
  })
  const inboundPluginEvents = new Set<(message: unknown) => void>()
  let overlayInvalidationMessage = false
  const observeOverlayInvalidation = (message: unknown): void => {
    if (message === null || typeof message !== 'object') return
    const event = message as { name?: unknown; payload?: { token?: unknown; rect?: unknown } }
    if (
      event.name === 'preview-placement' &&
      event.payload?.token === fixtureLease?.token &&
      event.payload.rect === null
    )
      overlayInvalidationMessage = true
  }
  inboundPluginEvents.add(observeOverlayInvalidation)
  const events = {
    send: () => {},
    listen: (_channel: string, handler: (message: unknown) => void) => {
      inboundPluginEvents.add(handler)
      return () => inboundPluginEvents.delete(handler)
    },
    liveRemote: () => host.displayed(),
  }
  const onPluginEvent = (event: Electron.IpcMainEvent, message: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame) return
    for (const handler of [...inboundPluginEvents]) handler(message)
  }
  ipcMain.on('plugin:apps', onPluginEvent)
  host = createPluginHost({
    plugins: [appsMain],
    registry,
    appFrames,
    userData: join(root, 'profile'),
    coreSeeds: [],
    active: () => active,
    rootFor: async (remote) => rootForRemote(remote),
    events,
    openAppDoor: (opener, remote) => capabilityHost.openAppDoor(opener, remote),
    route: () => () => {},
    binDir: () => root,
    githubToken: () => null,
    frameOrigin: () => () => {},
    notify: () => false,
    focused: () => currentWindow.isFocused(),
    window: () => currentWindow,
    readSettings: async () => ({
      ...VAULT_SETTING_DEFAULTS,
      warnings: [],
      plugins: { vault: {}, localOff: [] },
      pluginValues: {},
    }),
    call: async (remote, name, params, beforeInvoke) =>
      (await capabilityHost.dispatch({ door: 'ui', remote, name, params, beforeInvoke })).value,
  })
  const vault = (remote: keyof typeof roots): OpenVault => ({
    remote: `ada/${remote.toLowerCase()}`,
    root: roots[remote],
    pause: () => {},
    resume: () => {},
    drainSync: async () => {},
    commitNow: async () => null,
    repo: { head: async () => 'head' },
  })
  const serve = serveScheme(
    { owner: 'apps', scheme: appScheme },
    {
      active: () => active,
      runs: async (owner, vaultRoot) => (await host.serving(vaultRoot)).has(owner),
      appFrames,
      windowForRequest,
      frameForRequest: windowForRequest.frameForRequest,
    },
  )
  protocol.handle('holi-app', async (request) => {
    // Keep the classic script pending while the command document can send messages.
    if (new URL(request.url).pathname.endsWith('/command.js')) {
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
    return serve(request)
  })

  const checks: string[] = []
  let frameWindow: BrowserWindow | null = null
  let stopFrameWindowTracking: (() => void) | null = null
  const mark = (name: string): void => {
    checks.push(name)
    console.log(`PASS ${name}`)
  }
  try {
    for (const remote of ['A', 'B'] as const) {
      active = vault(remote)
      host.setDisplayed(active.remote)
      await host.reconcile(active, 'open')
      assert.deepEqual(host.failures(active.remote), {})
      await win.loadURL(
        `data:text/html,<!doctype html><div id="result"></div><iframe id="app" sandbox="allow-scripts" style="width:700px;height:450px;border:0"></iframe>`,
      )
      const lease = (
        await capabilityHost.dispatch({
          door: 'ui',
          remote: active.remote,
          name: 'apps.frameLease',
          params: { bundle },
        })
      ).value as { token: string; nonce: string }
      observedToken = lease.token
      revokedBeforeSvgScript = false
      const observedPromise = win.webContents.executeJavaScript(
        `new Promise((resolve,reject)=>{const onMessage=e=>{if(e.data?.kind==='app-smoke'){removeEventListener('message',onMessage);resolve(e.data.value)}};window.addEventListener('message',onMessage);document.querySelector('#app').src='holi-app://${leasedAppHost(bundle, lease.token)}/index.html';setTimeout(()=>reject(new Error('app frame timeout')),10000)})`,
      )
      const observed = await observedPromise
      assert.deepEqual(observed, {
        owner: remote,
        text: `owner-${remote}`,
        color: remote === 'A' ? 'rgb(180, 35, 24)' : 'rgb(23, 92, 211)',
        image: 32,
        nonce: lease.nonce,
        bridge: 'function',
      })
      mark(`leased-real-app-frame-owner-${remote.toLowerCase()}-resources`)
      const shot = `vault-app-${remote.toLowerCase()}.png`
      win.webContents.debugger.attach('1.3')
      let capture: { data: string }
      try {
        await win.webContents.debugger.sendCommand('Page.enable')
        capture = (await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
          captureBeyondViewport: true,
        })) as { data: string }
      } finally {
        win.webContents.debugger.detach()
      }
      writeFileSync(join(evidence, shot), Buffer.from(capture.data, 'base64'))
      assert(capture.data.length > 0)
      mark(`actual-vault-app-screenshot-${remote.toLowerCase()}`)
      const replacement = await win.webContents.executeJavaScript(
        `new Promise(resolve=>{const f=document.querySelector('#app');addEventListener('message',e=>{if(e.data?.kind==='svg-ran')resolve(true)},{once:true});f.src='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><script>parent.postMessage({kind:"svg-ran"},"*")<\\/script></svg>';setTimeout(()=>resolve(false),5000)})`,
      )
      assert.equal(replacement, true)
      assert.equal(revokedBeforeSvgScript, true)
      const validAfterSvg = await capabilityHost.dispatch({
        door: 'ui',
        remote: active.remote,
        name: 'apps.frameLeaseValid',
        params: { bundle, token: lease.token, nonce: lease.nonce },
      })
      assert.equal(validAfterSvg.value, false)
      await assert.rejects(
        capabilityHost.dispatch({
          door: 'ui',
          remote: active.remote,
          name: 'apps.call',
          params: { bundle, method: 'store.list', params: { collection: 'smoke' }, ...lease },
        }),
      )
      mark(
        `native-svg-replacement-revokes-before-subsequent-capability-use-${remote.toLowerCase()}`,
      )
      const legacy = await serve(new Request(`holi-app://${appHost(bundle)}/index.html`))
      assert.equal(legacy.status, 404)
      mark(`legacy-unleased-app-url-denied-${remote.toLowerCase()}`)
      const impostor = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      })
      try {
        await impostor.loadURL('data:text/html,<iframe id="app" sandbox="allow-scripts"></iframe>')
        const impersonation = await impostor.webContents.executeJavaScript(
          `new Promise(resolve=>{let got=false;addEventListener('message',e=>{if(e.data?.kind==='app-smoke')got=true});const f=document.querySelector('#app');f.src='holi-app://${leasedAppHost(bundle, lease.token)}/index.html';setTimeout(()=>resolve(got),750)})`,
        )
        assert.equal(impersonation, false)
      } finally {
        impostor.destroy()
      }
      mark(`foreign-window-app-request-denied-${remote.toLowerCase()}`)
      await capabilityHost.dispatch({
        door: 'ui',
        remote: active.remote,
        name: 'apps.releaseFrameLease',
        params: { bundle, token: lease.token },
      })
      const denied = await serve(
        new Request(`holi-app://${leasedAppHost(bundle, lease.token)}/index.html`),
      )
      assert.equal(denied.status, 404)
      mark(`revoked-app-lease-denied-${remote.toLowerCase()}`)
      const commandLease = (
        await capabilityHost.dispatch({
          door: 'ui',
          remote: active.remote,
          name: 'apps.frameLease',
          params: { bundle },
        })
      ).value as { token: string; nonce: string }
      const commandResult = await win.webContents.executeJavaScript(
        `new Promise((resolve,reject)=>{const frame=document.querySelector('#app');let handedInput=false;const onMessage=e=>{if(e.source!==frame.contentWindow||e.data?.nonce!=='${commandLease.nonce}')return;if(e.data.ready===true&&!handedInput){handedInput=true;frame.contentWindow.postMessage({nonce:'${commandLease.nonce}',run:{text:'command-${remote}'}},'*')}if(e.data.command){removeEventListener('message',onMessage);resolve(e.data)}};window.addEventListener('message',onMessage);frame.onload=null;frame.src='holi-app://${leasedAppHost(bundle, commandLease.token)}/?command=smoke&mode=dark';setTimeout(()=>reject(new Error('command runner timeout')),10000)})`,
      )
      assert.deepEqual(commandResult, {
        nonce: commandLease.nonce,
        command: {
          ok: true,
          value: { owner: remote, text: `command-${remote}`, registered: true },
        },
      })
      mark(`production-command-runner-result-${remote.toLowerCase()}`)
      mark(`production-command-runner-waits-for-command-script-${remote.toLowerCase()}`)
      await capabilityHost.dispatch({
        door: 'ui',
        remote: active.remote,
        name: 'apps.releaseFrameLease',
        params: { bundle, token: commandLease.token },
      })
    }
    active = vault('A')
    host.setDisplayed(active.remote)
    await host.reconcile(active, 'open')
    frameWindow = new BrowserWindow({
      width: 900,
      height: 700,
      show: true,
      webPreferences: {
        preload: process.env.HOLI_473_PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    currentWindow = frameWindow
    const capturePage = frameWindow.webContents.capturePage.bind(frameWindow.webContents)
    frameWindow.webContents.capturePage = async (...args) => {
      const image = await capturePage(...args)
      const gate = captureGate
      if (!image.isEmpty() && gate && !gate.used) {
        gate.used = true
        gate.entered()
        await gate.wait
      }
      return image
    }
    frameWindow.webContents.on('console-message', (details) => {
      console.log(`APPFRAME RENDERER [${details.level}] ${details.message}`)
    })
    frameWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
      console.log(`APPFRAME LOAD FAILED ${code} ${description} ${url}`)
    })
    stopFrameWindowTracking = trackAppFrameDocuments({
      contents: frameWindow.webContents,
      window: frameWindow,
      leases: appFrames,
      tokenFromUrl: (url) => {
        try {
          const parsed = new URL(url)
          return parsed.protocol === 'holi-app:'
            ? (appLeaseFromHost(parsed.hostname)?.token ?? null)
            : null
        } catch {
          return null
        }
      },
    })
    ipcMain.handle('holi:trpc', async (event, op: { path?: string; input?: unknown }) => {
      if (
        event.senderFrame !== event.sender.mainFrame ||
        !event.senderFrame.url.includes('/app-frame-renderer/index.html')
      )
        return { ok: false, message: 'untrusted fixture renderer' }
      if (op.path !== 'cap.run') return { ok: false, message: 'unsupported fixture procedure' }
      const input = op.input as { remote: string; name: string; paramsJson?: string }
      try {
        const params = input.paramsJson === undefined ? {} : JSON.parse(input.paramsJson)
        const result = await capabilityHost.dispatch({
          door: 'ui',
          remote: input.remote,
          name: input.name,
          params,
        })
        if (input.name === 'apps.frameLease') {
          fixtureLease = result.value as { token: string; nonce: string }
        }
        if (input.name === 'apps.call') {
          appCallCount += 1
        }
        if (input.name === 'apps.capturePreview') {
          captureResults.push((result.value as { saved: boolean }).saved)
        }
        return { ok: true, data: result.value }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    })
    const holdNextCapture = () => {
      let entered!: () => void
      let release!: () => void
      const waiting = new Promise<void>((resolve) => {
        entered = resolve
      })
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      const gate = { entered: () => entered(), wait, release: () => release(), used: false }
      captureGate = gate
      return {
        waiting,
        release: () => {
          captureGate = undefined
          gate.release()
        },
      }
    }
    const hiddenResultStart = captureResults.length
    const hiddenCapture = holdNextCapture()
    await frameWindow.loadFile(process.env.HOLI_473_RENDERER!)
    const readA = await frameWindow.webContents.executeJavaScript(
      `new Promise((resolve,reject)=>{const end=Date.now()+15000;const poll=()=>{const value=document.querySelector('#bridge-read-result')?.textContent??'';if(value.includes('owned-a'))resolve(value);else if(Date.now()>end)reject(new Error('production AppFrame bridge timed out: '+value+' '+document.body.innerHTML));else setTimeout(poll,50)};poll()})`,
    )
    assert.match(readA, /owned-a/)
    assert.doesNotMatch(readA, /owned-b/)
    mark('production-app-frame-hostbridge-trpc-preload-and-main-app-door-read-a')
    const callsAfterARead = appCallCount
    await frameWindow.webContents.executeJavaScript(
      `window.postMessage({id:'wrong-source-native',method:'docs.read',params:{path:'note.md'},nonce:window.fixtureNonces?.a},'*')`,
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(appCallCount, callsAfterARead)
    mark('production-app-frame-wrong-source-message-has-no-capability-side-effect')
    const captureFixture = async (filename: string) => {
      frameWindow!.webContents.debugger.attach('1.3')
      try {
        await frameWindow!.webContents.debugger.sendCommand('Page.enable')
        const image = (await frameWindow!.webContents.debugger.sendCommand(
          'Page.captureScreenshot',
          {
            captureBeyondViewport: true,
            fromSurface: true,
          },
        )) as { data: string }
        writeFileSync(join(evidence, filename), Buffer.from(image.data, 'base64'))
      } finally {
        frameWindow!.webContents.debugger.detach()
      }
    }
    await captureFixture('app-frame-read-a.png')
    await hiddenCapture.waiting
    await frameWindow.webContents.executeJavaScript(
      `window.postMessage({kind:'fixture-visible',visible:false},'*')`,
    )
    await frameWindow.webContents.executeJavaScript(
      `new Promise(resolve=>{const end=Date.now()+3000;const poll=()=>{const frame=document.querySelector('iframe');if(frame?.getAttribute('aria-hidden')==='true')resolve(true);else if(Date.now()>end)resolve(false);else setTimeout(poll,20)};poll()})`,
    )
    hiddenCapture.release()
    await waitForCaptureResult(hiddenResultStart, false)
    assert.equal(captureResults.at(-1), false)
    mark('production-app-frame-hidden-after-real-capture-rejects-stale-preview')
    await frameWindow.webContents.executeJavaScript(
      `window.postMessage({kind:'fixture-visible',visible:true},'*');window.postMessage({kind:'fixture-reload'},'*')`,
    )
    const previewA = await frameWindow.webContents.executeJavaScript(
      `new Promise((resolve,reject)=>{const end=Date.now()+12000;const poll=async()=>{try{const result=await window.holi.trpc({path:'cap.run',type:'mutation',input:{remote:'ada/a',name:'apps.preview',paramsJson:${JSON.stringify(JSON.stringify({ bundle }))}}});const data=result.data?.data??result.data;if(data?.dataUrl){resolve(data.dataUrl)}else if(Date.now()>end)reject(new Error('fresh actual preview capture timed out'));else setTimeout(poll,100)}catch(error){reject(error)}};poll()})`,
    )
    assert.match(previewA as string, /^data:image\/jpeg;base64,/)
    assert(captureResults.includes(true), 'real capture capability never saved a current preview')
    mark('production-app-frame-fresh-visible-capture-saved-native-preview')
    const overlayCaptureStart = captureResults.length
    const overlayCapture = holdNextCapture()
    await frameWindow.webContents.executeJavaScript(
      `window.postMessage({kind:'fixture-reload'},'*')`,
    )
    await overlayCapture.waiting
    await frameWindow.webContents.executeJavaScript(
      `(()=>{const overlay=document.createElement('div');overlay.id='smoke-capture-overlay';Object.assign(overlay.style,{position:'fixed',inset:'0',zIndex:'2147483647',background:'transparent'});document.body.append(overlay)})()`,
    )
    const invalidationDeadline = Date.now() + 5_000
    while (!overlayInvalidationMessage && Date.now() < invalidationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert(overlayInvalidationMessage, 'main did not receive overlay placement invalidation')
    overlayCapture.release()
    await waitForCaptureResult(overlayCaptureStart, false)
    assert.equal(captureResults.slice(overlayCaptureStart).at(-1), false)
    await capabilityHost.dispatch({
      door: 'ui',
      remote: 'ada/a',
      name: 'apps.forgetPreview',
      params: { bundle },
    })
    const noStalePreview = (
      await capabilityHost.dispatch({
        door: 'ui',
        remote: 'ada/a',
        name: 'apps.preview',
        params: { bundle },
      })
    ).value as { dataUrl: string | null }
    assert.equal(noStalePreview.dataUrl, null)
    await frameWindow.webContents.executeJavaScript(
      `document.querySelector('#smoke-capture-overlay')?.remove()`,
    )
    await frameWindow.webContents.executeJavaScript(
      `window.postMessage({kind:'fixture-reload'},'*')`,
    )
    const overlayRecovery = await frameWindow.webContents.executeJavaScript(
      `new Promise((resolve,reject)=>{const end=Date.now()+12000;const poll=async()=>{try{const result=await window.holi.trpc({path:'cap.run',type:'mutation',input:{remote:'ada/a',name:'apps.preview',paramsJson:${JSON.stringify(JSON.stringify({ bundle }))}}});const data=result.data?.data??result.data;if(data?.dataUrl)resolve(data.dataUrl);else if(Date.now()>end)reject(new Error('visible preview after overlay timed out'));else setTimeout(poll,100)}catch(error){reject(error)}};poll()})`,
    )
    assert.match(overlayRecovery as string, /^data:image\/jpeg;base64,/)
    mark('production-app-frame-overlay-without-layout-event-rejects-stale-capture-and-recovers')
    const reincarnationCapture = holdNextCapture()
    await frameWindow.webContents.executeJavaScript(
      `window.postMessage({kind:'fixture-reload'},'*')`,
    )
    await reincarnationCapture.waiting
    active = vault('B')
    host.setDisplayed(active.remote)
    await host.reconcile(active, 'open')
    await frameWindow.webContents.executeJavaScript(
      `window.postMessage({kind:'fixture-vault',remote:'ada/b'},'*')`,
    )
    const readB = await frameWindow.webContents.executeJavaScript(
      `new Promise((resolve,reject)=>{const end=Date.now()+15000;const poll=()=>{const value=document.querySelector('#bridge-read-result')?.textContent??'';if(value.includes('owned-b'))resolve(value);else if(Date.now()>end)reject(new Error('production AppFrame vault-B bridge timed out: '+value));else setTimeout(poll,50)};poll()})`,
    )
    assert.match(readB, /owned-b/)
    assert.doesNotMatch(readB, /owned-a/)
    mark('production-app-frame-hostbridge-trpc-preload-and-main-app-door-read-b')
    const callsAfterBRead = appCallCount
    await frameWindow.webContents.executeJavaScript(
      `document.querySelector('iframe').contentWindow.postMessage({kind:'fixture-stale',nonce:window.fixtureNonces?.a},'*')`,
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(appCallCount, callsAfterBRead)
    assert.equal(
      await frameWindow.webContents.executeJavaScript(
        `document.querySelector('#stale-result')?.textContent ?? ''`,
      ),
      '',
    )
    mark('production-app-frame-old-nonce-after-replacement-has-no-side-effect-or-reply')
    await captureFixture('app-frame-read-b.png')
    const captureCountBeforeReturn = captureResults.length
    active = vault('A')
    host.setDisplayed(active.remote)
    await host.reconcile(active, 'open')
    await frameWindow.webContents.executeJavaScript(
      `window.postMessage({kind:'fixture-vault',remote:'ada/a'},'*')`,
    )
    await frameWindow.webContents.executeJavaScript(
      `new Promise((resolve,reject)=>{const end=Date.now()+8000;const poll=()=>{if(document.querySelector('#active-vault')?.textContent==='ada/a')resolve(true);else if(Date.now()>end)reject(new Error('fixture did not return to vault A'));else setTimeout(poll,25)};poll()})`,
    )
    reincarnationCapture.release()
    await waitForCaptureResult(captureCountBeforeReturn, false)
    mark('production-app-frame-a-to-b-to-a-invalidates-delayed-real-capture')
    await frameWindow.webContents.executeJavaScript(
      `new Promise((resolve,reject)=>{const end=Date.now()+8000;const poll=()=>{if((document.querySelector('#bridge-read-result')?.textContent??'').includes('owned-a'))resolve(true);else if(Date.now()>end)reject(new Error('returned vault A bridge result did not settle'));else setTimeout(poll,25)};poll()})`,
    )
    // The old note stays in the host during reload. Readiness requires the
    // new document's nonce, not identical note text or an assigned frame src.
    const beforeReplacementNonce =
      await frameWindow.webContents.executeJavaScript(`window.fixtureNonces?.a`)
    assert.equal(typeof beforeReplacementNonce, 'string')
    const beforeReplacementReads = docsReadCount
    await frameWindow.webContents.executeJavaScript(
      `(()=>{const message=JSON.stringify({id:'replacement-native',method:'docs.read',params:{path:'note.md'},nonce:window.fixtureNonces?.a});const html='<script>addEventListener("message",event=>{if(event.data?.id==="replacement-native")parent.postMessage({kind:"replacement-result",value:event.data.value},"*")});parent.postMessage('+message+',"*")<\\/script>';document.querySelector('iframe').src='data:text/html,'+encodeURIComponent(html)})()`,
    )
    await frameWindow.webContents.executeJavaScript(
      `new Promise((resolve,reject)=>{const end=Date.now()+8000;const poll=()=>{const frame=document.querySelector('iframe');const nonce=window.fixtureNonces?.a;if(frame?.src.startsWith('holi-app:')&&typeof nonce==='string'&&nonce!==${JSON.stringify(beforeReplacementNonce)}&&(document.querySelector('#bridge-read-result')?.textContent??'').includes('owned-a'))resolve(true);else if(Date.now()>end)reject(new Error('AppFrame did not recover after replacement'));else setTimeout(poll,25)};poll()})`,
    )
    assert.equal(
      docsReadCount - beforeReplacementReads,
      1,
      'replacement request must not reach docs.read',
    )
    assert.equal(
      await frameWindow.webContents.executeJavaScript(
        `document.querySelector('#stale-result')?.textContent ?? ''`,
      ),
      '',
    )
    mark('production-app-frame-navigation-replacement-cannot-reach-hostbridge')

    assert(fixtureLease, 'fixture controller did not observe the issued app lease')
    const detachedLease = fixtureLease
    const detachedNativeLease = appFrames.resolveToken(detachedLease.token)
    assert(detachedNativeLease, 'native app lease was not registered')
    assert.equal(detachedNativeLease.valid(frameWindow), true)
    let readEntered!: () => void
    let releaseRead!: () => void
    const readStarted = new Promise<void>((resolve) => {
      readEntered = resolve
    })
    const readWait = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    docsReadGate = { entered: readEntered, wait: readWait, release: releaseRead }
    await frameWindow.webContents.executeJavaScript(
      `document.querySelector('iframe').contentWindow.postMessage({kind:'fixture-stale',nonce:window.fixtureNonces?.a},'*')`,
    )
    await readStarted
    const detachedResponse = await frameWindow.webContents.executeJavaScript(
      `(()=>{const frame=document.querySelector('iframe');frame.remove();return true})()`,
    )
    assert.equal(detachedResponse, true)
    assert.equal(detachedNativeLease.valid(frameWindow), false)
    assert.equal(appFrames.resolveToken(detachedLease.token), null)
    releaseRead()
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(
      await frameWindow.webContents.executeJavaScript(
        `document.querySelector('#stale-result')?.textContent ?? ''`,
      ),
      '',
      'detached child received a queued bridge reply',
    )
    mark('native-child-dom-removal-revokes-lease-and-suppresses-queued-bridge-reply')

    await frameWindow.webContents.reload()
    const reloadedRead = await frameWindow.webContents.executeJavaScript(
      `new Promise((resolve,reject)=>{const end=Date.now()+15000;const poll=()=>{const value=document.querySelector('#bridge-read-result')?.textContent??'';if(value.includes('owned-a'))resolve(value);else if(Date.now()>end)reject(new Error('fresh root reload AppFrame read timed out: '+value));else setTimeout(poll,50)};poll()})`,
    )
    assert.match(reloadedRead, /owned-a/)
    assert(fixtureLease, 'fresh root reload did not acquire a new app lease')
    assert.notEqual(fixtureLease.token, detachedLease.token)
    const reloadedLease = appFrames.resolveToken(fixtureLease.token)
    assert(reloadedLease?.valid(frameWindow), 'fresh root reload lease is not valid')
    mark('root-renderer-reload-revokes-old-lease-and-fresh-frame-reads-own-note')
    ipcMain.removeHandler('holi:trpc')
    await host.stopAll()
    return checks
  } finally {
    ipcMain.removeHandler('holi:trpc')
    ipcMain.off('plugin:apps', onPluginEvent)
    inboundPluginEvents.clear()
    stopFrameWindowTracking?.()
    frameWindow?.destroy()
    await host.stopAll()
    stopFrameTracking()
    stopObservingRevocations()
    appFrames.revokeAll()
    win.destroy()
    protocol.unhandle('holi-app')
  }
}
