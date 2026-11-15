import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, protocol, session, webContents } from 'electron'
import { VAULT_SETTING_DEFAULTS } from '@holi/shared'
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
  const roots = { A: join(root, 'vault-a'), B: join(root, 'vault-b') }
  for (const [owner, vaultRoot] of Object.entries(roots)) {
    mkdirSync(join(vaultRoot, bundle, 'nested'), { recursive: true })
    mkdirSync(join(vaultRoot, '.holi/settings'), { recursive: true })
    writeFileSync(join(vaultRoot, '.holi/settings/plugins.yaml'), 'plugins:\n  apps: true\n')
    const color = owner === 'A' ? '#b42318' : '#175cd3'
    writeFileSync(
      join(vaultRoot, bundle, 'index.html'),
      `<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><h1 id="owner">owner-${owner}</h1><img id="image" src="./nested/pixel.svg"><script src="/owner.js"></script></body></html>`,
    )
    writeFileSync(
      join(vaultRoot, bundle, 'owner.js'),
      `document.body.dataset.owner='${owner}';const image=document.querySelector('#image');image.addEventListener('load',()=>parent.postMessage({kind:'app-smoke',value:{owner:document.body.dataset.owner,text:document.querySelector('#owner').textContent,color:getComputedStyle(document.body).color,image:image.naturalWidth,nonce:document.querySelector('meta[name=holi-app-document-nonce]').content,bridge:typeof window.holi?.docs?.read}},'*'),{once:true});if(image.complete)image.dispatchEvent(new Event('load'))`,
    )
    writeFileSync(
      join(vaultRoot, bundle, 'app.yaml'),
      'commands:\n  smoke: { script: command.js }\n',
    )
    writeFileSync(
      join(vaultRoot, bundle, 'command.js'),
      `window.holi.command(input=>({owner:'${owner}',text:input.text}))`,
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
  const registry = createCapabilityRegistry()
  let active: OpenVault | null = null
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
  const events = { send: () => {}, listen: () => () => {}, liveRemote: () => host.displayed() }
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
    focused: () => win.isFocused(),
    window: () => win,
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
  protocol.handle('holi-app', serve)

  const checks: string[] = []
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
      await win.loadURL(
        `data:text/html,<!doctype html><div id="result"></div><iframe id="app" sandbox="allow-scripts" style="width:700px;height:450px;border:0"></iframe>`,
      )
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
        `new Promise((resolve,reject)=>{const frame=document.querySelector('#app');const onMessage=e=>{if(e.data?.command){removeEventListener('message',onMessage);resolve(e.data)}};window.addEventListener('message',onMessage);frame.onload=()=>frame.contentWindow.postMessage({nonce:'${commandLease.nonce}',run:{text:'command-${remote}'}},'*');frame.src='holi-app://${leasedAppHost(bundle, commandLease.token)}/?command=smoke&mode=dark';setTimeout(()=>reject(new Error('command runner timeout')),10000)})`,
      )
      assert.deepEqual(commandResult, {
        nonce: commandLease.nonce,
        command: { ok: true, value: { owner: remote, text: `command-${remote}` } },
      })
      mark(`production-command-runner-result-${remote.toLowerCase()}`)
      await capabilityHost.dispatch({
        door: 'ui',
        remote: active.remote,
        name: 'apps.releaseFrameLease',
        params: { bundle, token: commandLease.token },
      })
    }
    return checks
  } finally {
    await host.stopAll()
    stopFrameTracking()
    stopObservingRevocations()
    appFrames.revokeAll()
    win.destroy()
    protocol.unhandle('holi-app')
  }
}
