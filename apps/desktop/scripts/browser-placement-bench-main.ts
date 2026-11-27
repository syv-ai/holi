import assert from 'node:assert/strict'
import type { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, screen, session, type WebContentsView } from 'electron'
import { execFileSync } from 'node:child_process'
import { assertPlacementCounters, pageProcessIds } from './browser-placement-bench-analysis.mjs'
import { selectScenarios } from './browser-placement-bench-scenarios.mjs'
import { createTrialSampling } from './browser-placement-bench-sampling.mjs'
import { createBenchmarkSampling } from './browser-placement-bench-collection'
import { assertPlacementBounds } from './browser-placement-bench-bounds'
import { BROWSER_NAMESPACES, browserCapabilities } from '../src/plugins/browser/main/capabilities'
import { createPages } from '../src/plugins/browser/main/pages'
import { createCapabilityRegistry } from '../src/main/capabilities/registry'
import { noCoreServices } from '../src/main/capabilities/services'

const root = process.env.HOLI_BENCH_ROOT!
const evidence = process.env.HOLI_BENCH_EVIDENCE!
const seconds = Number(process.env.HOLI_BENCH_SECONDS ?? 10)
const warmup = Number(process.env.HOLI_BENCH_WARMUP ?? 2)
const repetitions = Number(process.env.HOLI_BENCH_REPETITIONS ?? 1)
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const metrics: unknown[] = []
const trials: {
  scenario: string
  trial: string
  valid: boolean
  reason: string | null
  counters: unknown
  durationMs: number
}[] = []
const placementMessages = { count: 0 }
const placementHistory: {
  at: number
  rect: { x: number; y: number; width: number; height: number } | null
}[] = []
const boundsDiagnosticHistory: unknown[] = []
const placementMessagesByScenario: Record<string, number> = {}
const placementTransitionsByScenario: Record<
  string,
  {
    entryPlacementMessages: number
    exitPlacementMessages: number
    entryByTrial: { trial: string; placementMessages: number; stats: unknown }[]
    exitByTrial: { trial: string; placementMessages: number; stats: unknown }[]
  }
> = {}

async function run(): Promise<void> {
  assert(root && evidence)
  assert.equal(
    process.env.HOLI_BENCH_FOCUS,
    'foreground',
    'explicit foreground declaration required',
  )
  for (const name of ['app-data', 'profile', 'session', 'vault'])
    mkdirSync(join(root, name), { recursive: true })
  app.setName('Holi Browser Placement Benchmark')
  app.setPath('appData', join(root, 'app-data'))
  app.setPath('userData', join(root, 'profile'))
  app.setPath('sessionData', join(root, 'session'))
  for (const [key, dir] of Object.entries({
    appData: 'app-data',
    userData: 'profile',
    sessionData: 'session',
  }))
    assert.equal(app.getPath(key as 'appData'), join(root, dir))
  await app.whenReady()
  let fixtureUrl: URL | null = null
  const allowed = (url: string): boolean => {
    try {
      const parsed = new URL(url)
      return (
        fixtureUrl !== null &&
        parsed.origin === fixtureUrl.origin &&
        parsed.pathname === '/' &&
        parsed.search === '' &&
        parsed.hash === ''
      )
    } catch {
      return false
    }
  }
  const hostSession = session.defaultSession
  hostSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  hostSession.setPermissionCheckHandler(() => false)
  hostSession.webRequest.onBeforeRequest((details, callback) => {
    const isRendererAsset =
      details.url.startsWith('file:') &&
      decodeURIComponent(new URL(details.url).pathname).startsWith(
        process.env.HOLI_BENCH_RENDERER! + '/',
      )
    callback({ cancel: !isRendererAsset && !allowed(details.url) })
  })
  const browserSession = session.fromPartition('persist:holi-browser')
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !allowed(details.url) }),
  )
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      '<!doctype html><meta charset="utf-8"><title>Local benchmark</title><style>body{font:16px sans-serif}main{height:2400px}</style><main>Local-only BrowserSurface placement benchmark</main>',
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}/`
  fixtureUrl = new URL(url)
  const win = new BrowserWindow({
    width: 1200,
    height: 850,
    show: false,
    webPreferences: {
      preload: process.env.HOLI_BENCH_PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith('file:')) event.preventDefault()
  })
  await win.loadFile(join(process.env.HOLI_BENCH_RENDERER!, 'index.html'))
  win.showInactive()
  await win.webContents.executeJavaScript(
    `window.__placementVisibilityEpoch = 0; document.addEventListener('visibilitychange', () => { window.__placementVisibilityEpoch++ })`,
  )
  let activeSampler: ReturnType<typeof createTrialSampling> | null = null
  const conditionEvents = ['focus', 'blur', 'show', 'hide', 'minimize', 'restore'] as const
  const conditionChanged = () => activeSampler?.transition({ type: 'window-condition' })
  const conditionEmitter: EventEmitter = win
  for (const event of conditionEvents) conditionEmitter.on(event, conditionChanged)
  assert.equal(app.getPath('userData'), join(root, 'profile'))
  const registry = createCapabilityRegistry()
  const pages = createPages({
    window: () => win,
    presentationLease: () => () => true,
    onDisplayChange: () => () => {},
    changed: (list) =>
      win.webContents.send('qa:event', { remote: 'bench', name: 'tabs', payload: list }),
    reveal: (id) =>
      win.webContents.send('qa:event', { remote: 'bench', name: 'reveal', payload: { id } }),
    address: () => {},
    key: () => {},
  })
  const unregister = registry.register(
    BROWSER_NAMESPACES,
    browserCapabilities(pages),
    'browser',
    'bench',
  )
  let live = true
  ipcMain.on('qa:plugin', (event, namespace, message) => {
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      namespace !== 'browser' ||
      !live
    )
      return
    if (message?.name === 'place' && message.remote === 'bench') {
      placementMessages.count++
      const payload = message.payload
      placementHistory.push({ at: performance.now(), rect: payload?.rect ?? null })
      if (placementHistory.length > 1000) placementHistory.shift()
      if (typeof payload?.id === 'string') pages.place(payload.id, payload.rect)
    }
  })
  ipcMain.handle('qa:trpc', async (event, op) => {
    assert.equal(event.sender, win.webContents)
    assert.equal(event.senderFrame, win.webContents.mainFrame)
    assert.equal(op.path, 'cap.run')
    const { remote, name, paramsJson } = op.input
    assert.equal(remote, 'bench')
    const result = await registry.run(
      name,
      'ui',
      {
        remote: 'bench',
        root: join(root, 'vault'),
        bundle: null,
        core: noCoreServices(),
        claims: async () => [],
        snapshot: async () => {
          throw new Error('unused')
        },
      },
      paramsJson ? JSON.parse(paramsJson) : undefined,
    )
    return { ok: true, data: result.value }
  })
  const guardedViews = new Set<number>()
  const allPageIds = new Set<number>()
  const allPagePids = new Set<number>()
  const pageContents = new Map<number, Electron.WebContents>()
  app.on('web-contents-created', (_event, contents) => {
    if (contents === win.webContents) return
    pageContents.set(contents.id, contents)
    allPageIds.add(contents.id)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const guard = (event: { preventDefault(): void }, target: string) => {
      if (!allowed(target)) event.preventDefault()
    }
    contents.on('will-navigate', guard)
    contents.on('will-redirect', guard)
    contents.once('did-finish-load', () => {
      if (allowed(contents.getURL())) allPagePids.add(contents.getOSProcessId())
    })
  })
  await pages.open({ id: 'bench-a', url, reveal: false })
  await pages.open({ id: 'bench-b', url, reveal: false })
  const restrictPageViews = (): void => {
    for (const view of win.contentView.children as WebContentsView[]) {
      if (guardedViews.has(view.webContents.id)) continue
      guardedViews.add(view.webContents.id)
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const guardNavigation = (event: { preventDefault(): void }, target: string): void => {
        if (!allowed(target)) event.preventDefault()
      }
      view.webContents.on('will-navigate', guardNavigation)
      view.webContents.on('will-redirect', guardNavigation)
    }
  }
  const waitFor = async (test: () => Promise<boolean>, name: string) => {
    const until = performance.now() + 15000
    while (performance.now() < until) {
      if (await test()) return
      await pause(50)
    }
    throw new Error(`timed out waiting for ${name}`)
  }
  await waitFor(() => win.webContents.executeJavaScript('!!window.bench'), 'fixture ready')
  await waitFor(async () => {
    const children = win.contentView.children as WebContentsView[]
    return children.length >= 1 && children.every((view) => view.webContents.getURL() === url)
  }, 'first native BrowserSurface attached')
  restrictPageViews()
  for (const view of win.contentView.children as WebContentsView[]) {
    allPageIds.add(view.webContents.id)
    allPagePids.add(view.webContents.getOSProcessId())
  }
  const scenarios = selectScenarios(process.env.HOLI_BENCH_SCENARIO)
  const collect = createBenchmarkSampling({ win, allPageIds, allPagePids, placementMessages })
  const sample = async (trial: string, phase: string, record = true) => {
    const result = await collect(trial, phase)
    if (record) metrics.push(result.observation)
    return result.snapshot
  }
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const scenario of scenarios) {
      placementMessages.count = 0
      if (scenario.prepare !== undefined) {
        await win.webContents.executeJavaScript(scenario.prepare)
        await waitFor(
          async () => win.contentView.children.length === scenario.prepareViews,
          `${scenario.name} pre-overlay native view count`,
        )
      }
      if (scenario.name === 'imperative-web-animation') await pause(1500)
      placementMessages.count = 0
      await win.webContents.executeJavaScript(
        `if (window.__placementBenchStats) { window.__placementBenchStats.callbacks = 0; window.__placementBenchStats.hostRects = 0; window.__placementBenchStats.coverageScans = 0; window.__placementBenchStats.overlayRects = 0 }`,
      )
      let resizeTimer: NodeJS.Timeout | undefined
      if (scenario.name === 'native-resize') {
        resizeTimer = setInterval(() => {
          const [w, h] = win.getSize()
          win.setSize(w === 1200 ? 1250 : 1200, h === 850 ? 900 : 850)
        }, 250)
      }
      await win.webContents.executeJavaScript(scenario.configure)
      if (scenario.name === 'portal-overlap-entry-movement-exit') {
        await waitFor(
          async () => win.contentView.children.length === 0,
          'overlay covering detaches native view',
        )
        await win.webContents.executeJavaScript('window.bench.setOverlap(false)')
        await waitFor(
          async () => win.contentView.children.length === 1,
          'overlay moved away restores native view',
        )
        await win.webContents.executeJavaScript('window.bench.setOverlap(true)')
        await waitFor(
          async () => win.contentView.children.length === 0,
          'overlay moved back detaches native view',
        )
      }
      if (scenario.name === 'imperative-web-animation') {
        await waitFor(
          async () =>
            win.webContents.executeJavaScript(
              "[...document.getAnimations()].some((animation) => animation.playState === 'running')",
            ),
          'imperative Web Animation started',
        )
      }
      await waitFor(
        async () => win.contentView.children.length === scenario.expectedViews,
        `${scenario.name} native view count`,
      )
      restrictPageViews()
      await pause(120)
      const boundsDiagnostic = (await win.webContents.executeJavaScript(
        `([...document.querySelectorAll('[data-browser-tab] > div:last-child')].map((el) => { const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height } }).filter((r) => r.width >= 1 && r.height >= 1))`,
      )) as { x: number; y: number; width: number; height: number }[]
      const nativeDiagnostic = (win.contentView.children as WebContentsView[]).map((view) =>
        view.getBounds(),
      )
      if (scenario.expectedViews === 0) {
        assert.equal(
          nativeDiagnostic.length,
          0,
          `${scenario.name}: detached state must have no native views`,
        )
      } else {
        if (boundsDiagnostic.length !== nativeDiagnostic.length)
          throw new Error(`${scenario.name}: renderer/native bounds count mismatch`)
      }
      await assertPlacementBounds({
        win,
        expectedViews: scenario.expectedViews,
        placementHistory,
        boundsDiagnosticHistory,
        label: scenario.name,
      })
      if (scenario.name === 'ancestor-scroll' || scenario.name === 'split-resize') {
        await win.webContents.executeJavaScript(`window.bench.startWorkload('${scenario.name}')`)
      }
      if (
        ['native-resize', 'ancestor-scroll', 'split-resize', 'transform-animation'].includes(
          scenario.name,
        ) ||
        scenario.name === 'imperative-web-animation'
      ) {
        for (let sample = 0; sample < 20; sample++) {
          await pause(50)
          await assertPlacementBounds({
            win,
            expectedViews: scenario.expectedViews,
            placementHistory,
            boundsDiagnosticHistory,
            label: `${scenario.name} motion sample ${sample + 1}`,
          })
        }
      }
      const transitions = (placementTransitionsByScenario[scenario.name] ??= {
        entryPlacementMessages: 0,
        exitPlacementMessages: 0,
        entryByTrial: [],
        exitByTrial: [],
      })
      transitions.entryPlacementMessages += placementMessages.count
      if (process.env.HOLI_BENCH_COUNTS === '1') {
        const stats = await win.webContents.executeJavaScript(
          'window.__placementBenchStats ?? null',
        )
        assertPlacementCounters(stats)
      }
      transitions.entryByTrial.push({
        trial: `rep-${repetition + 1}`,
        placementMessages: placementMessages.count,
        stats: await win.webContents.executeJavaScript('window.__placementBenchStats ?? null'),
      })
      await pause(500)
      if (warmup > 0) await pause(warmup * 1000)
      placementMessages.count = 0
      await win.webContents.executeJavaScript(
        `if (window.__placementBenchStats) { window.__placementBenchStats.callbacks = 0; window.__placementBenchStats.hostRects = 0; window.__placementBenchStats.coverageScans = 0; window.__placementBenchStats.overlayRects = 0 }`,
      )
      const trial = `rep-${repetition + 1}`
      const start = performance.now()
      const deadline = start + seconds * 1000
      // Electron's first app.getAppMetrics() CPU observation is a zero baseline. Prime it
      // after trial setup so the first measured interval cannot include setup or warmup.
      await sample(trial, scenario.name, false)
      const sampler = createTrialSampling({
        condition: { focused: true, visible: true, minimized: false },
        counters: process.env.HOLI_BENCH_COUNTS === '1',
      })
      activeSampler = sampler
      const initial = await win.webContents.executeJavaScript(`(() => {
        const stats = window.__placementBenchStats;
        if (stats) for (const key of ['callbacks','hostRects','coverageScans','overlayRects']) stats[key] = 0;
        return {stats: stats ? {...stats} : null, visibilityEpoch: window.__placementVisibilityEpoch, visible: document.visibilityState === 'visible'};
      })()`)
      sampler.observe({
        condition: {
          focused: win.isFocused(),
          visible: win.isVisible() && initial.visible,
          minimized: win.isMinimized(),
        },
        stats: initial.stats,
        visibilityEpoch: initial.visibilityEpoch,
      })
      while (performance.now() < deadline) {
        await pause(Math.min(1000, Math.max(0, deadline - performance.now())))
        if (performance.now() >= deadline) break
        const snapshot = await sample(trial, scenario.name)
        sampler.observe(snapshot)
      }
      const terminal = await sample(trial, scenario.name)
      const result = sampler.finish(terminal)
      activeSampler = null
      trials.push({
        scenario: scenario.name,
        trial,
        ...result,
        durationMs: performance.now() - start,
      })
      await win.webContents.executeJavaScript('window.bench.stopWorkload()')
      if (resizeTimer) clearInterval(resizeTimer)
      placementMessagesByScenario[scenario.name] =
        (placementMessagesByScenario[scenario.name] ?? 0) + placementMessages.count
      placementMessages.count = 0
      await win.webContents.executeJavaScript(
        `if (window.__placementBenchStats) { window.__placementBenchStats.callbacks = 0; window.__placementBenchStats.hostRects = 0; window.__placementBenchStats.coverageScans = 0; window.__placementBenchStats.overlayRects = 0 }`,
      )
      await win.webContents.executeJavaScript('window.bench.setOverlay(false)')
      if (scenario.name === 'portal-overlap-entry-movement-exit') {
        await waitFor(
          async () => win.contentView.children.length === 1,
          `${scenario.name} overlay exit restore`,
        )
      }
      await pause(250)
      transitions.exitPlacementMessages += placementMessages.count
      transitions.exitByTrial.push({
        trial: `rep-${repetition + 1}`,
        placementMessages: placementMessages.count,
        stats: await win.webContents.executeJavaScript('window.__placementBenchStats ?? null'),
      })
      if (scenario.finish) await win.webContents.executeJavaScript(scenario.finish)
      await win.webContents.executeJavaScript('window.bench.setVisible(false)')
      await waitFor(
        async () => win.contentView.children.length === 0,
        `${scenario.name} final hide detach`,
      )
    }
  }
  const result = {
    schema: 'holi-browser-placement-bench-v1',
    runMode:
      process.env.HOLI_BENCH_COUNTS === '1'
        ? 'placement-counts-diagnostic'
        : 'minimally-instrumented-resource',
    variant: process.env.HOLI_BENCH_VARIANT,
    source: process.env.HOLI_BENCH_SOURCE,
    hybridHash: process.env.HOLI_BENCH_HYBRID_HASH || null,
    processes: {
      mainPid: process.pid,
      hostRendererWebContentsId: win.webContents.id,
      browserPageWebContentsIds: [...allPageIds],
      attachedBrowserPageWebContentsIds: [
        ...new Set(
          (win.contentView.children as WebContentsView[]).map((view) => view.webContents.id),
        ),
      ],
      browserPagePids: pageProcessIds(
        [...pageContents.values()]
          .filter((contents) => allowed(contents.getURL()))
          .map((contents) => ({ pid: contents.getOSProcessId() })),
      ),
      gpuProcessCpuAvailableOnlyThroughAppMetrics: true,
      cpuUnits: 'one-core percent normalized from Electron machine percent by logical CPU count',
    },
    localServer: { host: '127.0.0.1', port: address.port },
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    scaleFactor: screen.getPrimaryDisplay().scaleFactor,
    measurementConditions: {
      backgroundThrottling: false,
      focusAndVisibility:
        'explicit foreground condition; Electron condition events and monotonic renderer visibility epoch latch transitions through terminal capture',
      occlusion:
        'native window occlusion by unrelated windows is not controlled; do not focus or stop other applications',
    },
    display: {
      size: screen.getPrimaryDisplay().size,
      workArea: screen.getPrimaryDisplay().workArea,
      refreshRateHz: screen.getPrimaryDisplay().displayFrequency,
    },
    powerSource:
      process.platform === 'darwin'
        ? {
            privilege: 'unprivileged',
            battery: execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' }),
            thermal: execFileSync('pmset', ['-g', 'therm'], { encoding: 'utf8' }),
          }
        : null,
    roots: {
      appData: app.getPath('appData'),
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'),
      vault: join(root, 'vault'),
    },
    scenarios,
    boundsDiagnostic: {
      policy:
        'renderer rectangles sampled on host requestAnimationFrame; exact rounded native bounds and a matching production placement IPC must align within three observed host frames',
      samples: boundsDiagnosticHistory,
      placementIpcHistory: placementHistory,
    },
    observations: metrics,
    trials,
    placementMessages: Object.values(placementMessagesByScenario).reduce(
      (sum, count) => sum + count,
      0,
    ),
    placementMessagesByScenario,
    placementTransitionsByScenario,
    gpuUtilization: null,
    energy: null,
  }
  writeFileSync(join(evidence, 'baseline.json'), JSON.stringify(result, null, 2))
  activeSampler = null
  for (const event of conditionEvents) conditionEmitter.removeListener(event, conditionChanged)
  live = false
  ipcMain.removeHandler('qa:trpc')
  ipcMain.removeAllListeners('qa:plugin')
  unregister()
  pages.dispose()
  server.close()
  app.quit()
}

void run().catch((error) => {
  writeFileSync(join(evidence, 'failure.txt'), `${error instanceof Error ? error.stack : error}\n`)
  console.error(error)
  app.exit(1)
})
