import { app, BrowserWindow, ipcMain, session } from 'electron'
import { startBenchmarkCapture, type BenchmarkCapture } from './vault-snapshot-bench-capture'
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { loadavg } from 'node:os'
import { processObservables } from './vault-snapshot-bench-metrics.mjs'
import { freezeMeasurement, trialSucceeded } from './vault-snapshot-bench-analysis.mjs'
import { createHash } from 'node:crypto'
import { emptyVaultSnapshot, VAULT_SETTING_DEFAULTS } from '@holi/shared'
import type { MainPlugin, Notice } from '../src/main/plugin-api'
import { createPluginHost } from '../src/main/plugin-host/host'
import { tasksMain } from '../src/plugins/tasks/main'
import { join } from 'node:path'
import { openRepo } from '../src/main/git'
import { openActiveVault, type ActiveVault } from '../src/main/vault/active-vault'
import { createSnapshotBenchAdapter } from './vault-snapshot-bench-adapter'
import { createBenchRpc } from './vault-snapshot-bench-rpc'

export function shouldSendSnapshot(previous: string | null, next: unknown, force = false): boolean {
  return force || previous === null || previous !== JSON.stringify(next)
}

const root = process.env.HOLI_544_ROOT
const evidence = process.env.HOLI_544_EVIDENCE
const trialText = process.env.HOLI_544_TRIAL
if (!root || !evidence || !trialText)
  throw new Error('HOLI_544_ROOT, HOLI_544_EVIDENCE and HOLI_544_TRIAL are required')
const trial = JSON.parse(trialText) as {
  id: string
  mode: 'baseline' | 'candidate'
  size: 'small' | 'large'
  warmupSeconds: number
  durationSeconds: number
  pilot: boolean
  smoke?: boolean
}
type MetricRow = {
  at: number
  pid: number
  type: string
  name: string
  cpuPercent: number
  cumulativeCpuUsage?: number
  workingSetBytes: number
  privateBytes?: number
}

async function run(root: string, evidence: string): Promise<void> {
  const paths = {
    appData: join(root, 'app-data'),
    userData: join(root, 'user-data'),
    sessionData: join(root, 'session-data'),
    vault: join(root, 'vault'),
  }
  for (const path of [...Object.values(paths), evidence]) mkdirSync(path, { recursive: true })
  app.setName('Holi snapshot benchmark')
  app.setPath('appData', paths.appData)
  app.setPath('userData', paths.userData)
  app.setPath('sessionData', paths.sessionData)
  process.env.HOLI_VAULT_ROOT = paths.vault
  if (
    [app.getPath('userData'), app.getPath('appData'), app.getPath('sessionData')].some(
      (path) => !path.startsWith(root),
    )
  )
    throw new Error('Electron data path escaped benchmark root')
  await app.whenReady()
  const denied: string[] = []
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^(file|data|devtools):/.test(details.url)) callback({})
    else {
      denied.push(details.url)
      callback({ cancel: true })
    }
  })
  let win: BrowserWindow | null = null
  let active: ActiveVault | null = null
  let adapter: ReturnType<typeof createSnapshotBenchAdapter> | null = null
  let host: ReturnType<typeof createPluginHost> | null = null
  let sampleInterval: NodeJS.Timeout | null = null
  let capture: BenchmarkCapture | null = null
  let captureResult: Awaited<ReturnType<BenchmarkCapture['stop']>> | null = null
  let captureSampling = Promise.resolve()
  const cleanupLedger: string[] = []
  const samples: Array<{
    at: number
    elapsedSeconds: number
    hostLoad: number[]
    processes: MetricRow[]
  }> = []
  let snapshotDigest = ''
  let snapshotNotifications = 0
  let scanStartedAt: { at: number; measured: boolean } | null = null
  const scanDurationsMs: number[] = []
  let measuring = false
  const publicationLatencyMs: number[] = []
  const pipelinePromises = new Set<Promise<unknown>>()
  const sendStats = { count: 0 }
  const started = performance.now()
  let visibilityBeforeIdle: unknown = null
  let visibilityAfterIdle: unknown = null
  let finished = false
  let rendererStats: unknown = null
  let measured: any = null
  let nativeUserChangesLatency: any = null
  const cleanupErrors: string[] = []
  const pipelineErrors: string[] = []
  const settlePipeline = async () => {
    while (pipelinePromises.size) await Promise.allSettled([...pipelinePromises])
  }
  const drainPipeline = async () => {
    await settlePipeline()
    if (pipelineErrors.length) throw new Error(pipelineErrors.join('; '))
  }
  const pilotAssertions: string[] = []
  let pilotValid = true
  let tasksEnabled = true
  const cleanup = async () => {
    measuring = false
    adapter?.dispose()
    if (sampleInterval) clearInterval(sampleInterval)
    sampleInterval = null
    await captureSampling
    try {
      await capture?.dispose()
    } catch (error) {
      cleanupErrors.push(`capture.dispose: ${error}`)
    }
    capture = null
    // Close the watcher first, then drain callbacks before stopping their host.
    if (active) {
      try {
        await active.refresh()
      } catch (error) {
        cleanupErrors.push(`vault.refresh before close: ${error}`)
      }
      try {
        await active.close()
        cleanupLedger.push('vault.close')
      } catch (error) {
        cleanupErrors.push(`vault.close: ${error}`)
      }
    }
    try {
      await settlePipeline()
    } catch (error) {
      cleanupErrors.push(`pipeline.drain: ${error}`)
    }
    if (host) {
      try {
        await host.stopAll()
        cleanupLedger.push('plugins.stopAll')
      } catch (error) {
        cleanupErrors.push(`plugins.stopAll: ${error}`)
      } finally {
        host = null
      }
    }
    active = null
    if (win && !win.isDestroyed()) {
      try {
        win.destroy()
        cleanupLedger.push('window.destroy')
      } catch (error) {
        cleanupErrors.push(`window.destroy: ${error}`)
      }
    }
    win = null
    ipcMain.removeHandler('holi:trpc')
    ipcMain.removeHandler('vault:snapshot-bench')
  }
  const finish = async (error?: unknown) => {
    if (finished) return
    finished = true
    try {
      if (win && !win.isDestroyed())
        await win.webContents
          .executeJavaScript('window.snapshotBench?.dispose?.()')
          .catch((error) => {
            cleanupErrors.push(`renderer.dispose: ${error}`)
          })
      const snapshot = measured?.snapshot ?? null
      const finalSnapshotDigest = snapshot ? digest(JSON.stringify(snapshot)) : ''
      await cleanup()
      const observations = processObservables({ samples: measured?.samples ?? [] })
      const observationError =
        observations === null ? new Error('Invalid process observations') : undefined
      const result = {
        ok: trialSucceeded({
          error: error ?? observationError,
          cleanupErrors,
          valid:
            denied.length === 0 &&
            pilotValid &&
            Boolean(nativeUserChangesLatency?.complete) &&
            (measured?.samples.length ?? 0) >= 2 &&
            (measured?.scanDurationsMs.length ?? 0) > 0 &&
            Boolean(rendererStats) &&
            (measured?.adapter.scans ?? 0) > 0 &&
            Boolean(snapshot) &&
            Boolean(captureResult?.physicalGpu.available) &&
            Boolean(captureResult?.allocation.main && captureResult?.allocation.renderer),
        }),
        error:
          error === undefined && observationError === undefined
            ? null
            : String(error ?? observationError),
        trial,
        mode: trial.mode,
        snapshot,
        snapshotChecksum: snapshot ? finalSnapshotDigest : null,
        rendererStats,
        snapshotNotifications: measured?.snapshotNotifications ?? null,
        publicationLatencyMs: measured?.publicationLatencyMs ?? null,
        publicationLatencyBoundary:
          'timed snapshot callback entry before candidate fingerprint/serialization/plugin pipeline through adapter completion and renderer atom delivery plus snapshot-consumer layout commit and two animation frames; suppressed candidates use two animation frames after pipeline completion; excludes filesystem scan',
        snapshotNotificationDigest: snapshotDigest || finalSnapshotDigest,
        snapshotCounts: snapshot ? snapshotCount(snapshot) : null,
        scans: measured?.scanDurationsMs.length ?? 0,
        scanDurationsMs: measured?.scanDurationsMs ?? [],
        rendererSends: measured?.rendererSends ?? null,
        adapter: measured?.adapter ?? null,
        nativeUserChangesLatency,
        diagnosticCountersAfterIdle: {
          rendererSends: { count: sendStats.count },
          adapter: adapter?.metrics(),
        },
        allocation: captureResult?.allocation ?? null,
        physicalGpu: captureResult?.physicalGpu ?? null,
        profilingOverhead: captureResult?.profilingOverhead ?? null,
        protocolRevision: 4,
        mainBundleSha256: digest(readFileSync(join(root, 'main.cjs'), 'utf8')),
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        samples: measured?.samples ?? [],
        denied,
        cleanupLedger,
        cleanupErrors,
        pipelineErrors,
        wiring: 'reproduced main/index.ts snapshot callback order with production plugin host',
        cpuUnit:
          'CPU seconds, sum of per-process cumulative CPU deltas; fallback percent/100 × elapsed seconds',
        cpuSeconds: observations?.cpuSeconds ?? null,
        processBreakdown: aggregateProcesses(measured?.samples ?? []),
        sampleElapsedSeconds: observations?.sampleElapsedSeconds ?? null,
        visibility: {
          policy: 'showInactive; no activation requests',
          beforeIdle: visibilityBeforeIdle,
          afterIdle: visibilityAfterIdle,
        },
        phases: {
          warmupSeconds: trial.warmupSeconds,
          measurementSeconds: trial.durationSeconds,
          diagnosticAfterMeasurement: true,
          idle: 'all top-level counters, rendererStats, samples and CPU cover only timed idle; renderer commits count snapshot-consumer layout effects, not all React commits',
          changedUpdates:
            'nativeUserChangesLatency: five real task edits after idle, restored before cleanup',
          pilot: 'extra correctness checks after changed-update diagnostics',
        },
        verifiedModules: ['openActiveVault', 'createPluginHost', 'tasksMain'],
        counterFlags: {
          nonEmptySnapshot: Boolean(snapshot),
          genuineSamples: (measured?.samples.length ?? 0) >= 2,
          genuineScans: (measured?.scanDurationsMs.length ?? 0) > 0,
          genuineRendererStats: Boolean(rendererStats),
        },
        pilotCorrectness: trial.pilot ? pilotAssertions : null,
      }
      writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
      writeFileSync(
        join(evidence, 'raw-samples.json'),
        JSON.stringify(measured?.samples ?? [], null, 2),
      )
      if (!result.ok) process.exitCode = 1
    } catch (cleanupError) {
      console.error(cleanupError)
      process.exitCode = 1
    }
    app.exit(Number(process.exitCode ?? 0))
  }
  process.once('SIGINT', () => void finish(new Error('SIGINT')))
  process.once('SIGTERM', () => void finish(new Error('SIGTERM')))
  try {
    win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: {
        preload: join(root, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    win.showInactive()
    const visibility = () => ({ visible: win!.isVisible(), focused: win!.isFocused() })
    const web = win.webContents
    web.on('console-message', (event) => console.error('[snapshot-bench renderer]', event.message))
    const isAuthorized = (event: Electron.IpcMainInvokeEvent) =>
      event.sender === web && event.senderFrame === web.mainFrame && !web.isDestroyed()
    const publish = (channel: string, payload: unknown) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    }
    const remote = 'bench/snapshot'
    const inertAgent: MainPlugin = {
      info: { id: 'agent', label: 'Inert benchmark agent', builtIn: true, default: true },
    }
    host = createPluginHost({
      plugins: [tasksMain, inertAgent],
      registry: { register: () => () => {} },
      userData: paths.userData,
      coreSeeds: [],
      active: () => active,
      rootFor: async (at) => (at === remote ? paths.vault : null),
      readSettings: async () => ({
        ...VAULT_SETTING_DEFAULTS,
        plugins: { vault: { tasks: true }, localOff: tasksEnabled ? [] : ['tasks'] },
        warnings: [],
      }),
      events: { send: () => {}, listen: () => () => {}, liveRemote: () => remote },
      openAppDoor: () => {
        throw new Error('No app door in benchmark')
      },
      route: () => () => {},
      binDir: () => root,
      githubToken: () => null,
      frameOrigin: () => () => {},
      notify: (_notice: Notice) => false,
      navigate: () => {},
      focused: () => false,
    })
    adapter = createSnapshotBenchAdapter({
      mode: trial.mode,
      remote,
      getVault: () => active,
      host,
      send: (payload) => {
        sendStats.count++
        // The adapter already accounts serialized bytes symmetrically in both modes.
        // Do not serialize again here or retain payload bodies per send.
        snapshotNotifications++
        publish('vault:snapshot', payload)
      },
      refresh: () => {
        void active?.refresh()
      },
      pluginReady: () => true,
      fingerprint: async () => contentFingerprint(paths.vault),
    })
    host.setDisplayed(remote)
    active = await openActiveVault({
      remote,
      repo: openRepo(paths.vault),
      claims: () => {
        scanStartedAt = { at: performance.now(), measured: measuring }
        return host!.scanClaimsFor(paths.vault)
      },
      onSnapshot(snapshot) {
        const publicationStartedAt = measuring ? performance.now() : null
        const sendsBeforePublication = sendStats.count
        const rendererBefore = measuring
          ? (win?.webContents.executeJavaScript('window.snapshotBench.metrics()') as
              | Promise<{
                  atomWrites: number
                  commits: number
                }>
              | undefined)
          : undefined
        const scan = scanStartedAt
        scanStartedAt = null
        if (measuring && scan?.measured) scanDurationsMs.push(performance.now() - scan.at)
        // Drain the complete pending pipeline, not a resolved adapter promise whose
        // settlement still needs renderer I/O; the latter starves the main event loop.
        const promise = (async () => {
          const before = await rendererBefore
          await adapter!.onSnapshot(snapshot)
          if (publicationStartedAt !== null) {
            const sent = sendStats.count > sendsBeforePublication
            await win!.webContents.executeJavaScript(
              `window.snapshotBench.settlePublication(${sent}, ${before?.atomWrites ?? 0}, ${before?.commits ?? 0})`,
            )
            publicationLatencyMs.push(performance.now() - publicationStartedAt)
          }
        })()
        pipelinePromises.add(promise)
        void promise.then(
          () => pipelinePromises.delete(promise),
          (error) => {
            pipelineErrors.push(`snapshot pipeline: ${String(error)}`)
            pipelinePromises.delete(promise)
          },
        )
      },
      onSyncState: (state) => publish('vault:sync', { remote, state }),
      onHeldBack: (files) => publish('vault:heldback', { remote, files }),
      onCommitted: (paths) => publish('vault:committed', { remote, paths }),
      timings: { healIntervalMs: 30_000, pullIntervalMs: 30_000 },
    })
    const handlers = [
      'vault:snapshot',
      'vault:sync',
      'vault:heldback',
      'vault:committed',
      'vault:open',
      'vault:navigate',
    ]
    for (const channel of handlers)
      ipcMain.on(channel, (event) => {
        if (!isAuthorized(event)) event.preventDefault()
      })
    const rpc = createBenchRpc({
      root: paths.vault,
      remote,
      getSnapshot: () => active?.snapshot() ?? emptyVaultSnapshot(),
    })
    ipcMain.handle(
      'holi:trpc',
      async (event, operation: Parameters<ReturnType<typeof createBenchRpc>>[0]) => {
        if (!isAuthorized(event)) throw new Error('Unauthorized benchmark IPC sender')
        if (
          operation.path === 'vaults.refresh' &&
          (operation.input as { remote?: string } | undefined)?.remote === remote
        ) {
          if (!active) throw new Error('Benchmark vault is not open')
          await active.refresh()
          return { ok: true, data: active.snapshot() }
        }
        return rpc(operation)
      },
    )
    ipcMain.handle('vault:snapshot-bench', async (event, action: string, force = false) => {
      if (!isAuthorized(event)) throw new Error('Unauthorized benchmark IPC sender')
      if (action !== 'scan') throw new Error(`Unsupported action: ${action}`)
      if (!active) throw new Error('Benchmark vault is not open')
      await active.refresh()
      if (force) await adapter?.onSnapshot(active.snapshot() ?? emptyVaultSnapshot(), true)
      return { snapshot: active.snapshot(), metrics: adapter?.metrics() }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    await host.reconcile(active, 'open')
    await win.loadFile(join(root, 'renderer.html'))
    let readinessTimeout: NodeJS.Timeout | undefined
    let ready: unknown
    try {
      ready = await Promise.race([
        win.webContents.executeJavaScript('window.snapshotBench?.ready'),
        new Promise((_, reject) => {
          readinessTimeout = setTimeout(
            () => reject(new Error('Renderer readiness timed out')),
            20_000,
          )
        }),
      ])
    } finally {
      clearTimeout(readinessTimeout)
    }
    if (ready !== true) throw new Error('Renderer subscriptions did not become ready')
    await active.refresh()
    const first = active.snapshot()
    if (!first || typeof first !== 'object') throw new Error('Production vault snapshot missing')
    const sendsBeforeInitialForce = sendStats.count
    await adapter.onSnapshot(first, true)
    const initialForcePassed = sendStats.count > sendsBeforeInitialForce
    pilotAssertions.push(
      `${initialForcePassed ? 'PASS' : 'FAIL'}: forced initial snapshot after renderer readiness`,
    )
    if (!initialForcePassed) pilotValid = false
    const dataReady = await win.webContents.executeJavaScript('window.snapshotBench.dataReady')
    if (dataReady !== true) throw new Error('Production consumers did not load fixture content')
    if (trial.pilot) {
      const dom = await win.webContents.executeJavaScript(`({
        document: document.querySelector('[contenteditable="true"].tiptap')?.textContent ?? '',
        task: document.querySelector('[data-bench-task]')?.textContent ?? ''
      })`)
      const consumersValid =
        dom.document.includes('Deterministic fixture body 0.') && dom.task.includes('Task 0')
      pilotAssertions.push(
        `${consumersValid ? 'PASS' : 'FAIL'}: production document and task consumers render fixture content`,
      )
      if (!consumersValid) pilotValid = false
    }
    writeFileSync(
      join(evidence, 'main-ready.json'),
      JSON.stringify({
        trial,
        paths,
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        readiness: ready,
      }),
    )
    const sample = () => {
      const at = performance.now()
      const atSeconds = (at - started) / 1000
      if (capture) {
        captureSampling = captureSampling
          .then(() => capture!.samplePhysicalGpu(atSeconds))
          .catch((error) => {
            pipelineErrors.push(`physical GPU sample: ${String(error)}`)
          })
      }
      const rows = app.getAppMetrics()
      samples.push({
        at: atSeconds,
        elapsedSeconds: samples.length ? atSeconds - samples.at(-1)!.at : 0,
        hostLoad: loadavg(),
        processes: rows.map((row) => ({
          at: (at - started) / 1000,
          pid: row.pid,
          type: row.type,
          name: row.name ?? row.type,
          cpuPercent: row.cpu.percentCPUUsage,
          ...(typeof row.cpu.cumulativeCPUUsage === 'number'
            ? { cumulativeCpuUsage: row.cpu.cumulativeCPUUsage }
            : {}),
          workingSetBytes: row.memory.workingSetSize * 1024,
          ...(typeof row.memory.privateBytes === 'number'
            ? { privateBytes: row.memory.privateBytes * 1024 }
            : {}),
        })),
      })
    }
    await new Promise((resolve) => setTimeout(resolve, trial.warmupSeconds * 1000))
    await drainPipeline()
    capture = await startBenchmarkCapture(win.webContents)
    await win.webContents.executeJavaScript('window.snapshotBench.resetMetrics()')
    adapter.resetMetrics()
    samples.length = 0
    sample()
    snapshotNotifications = 0
    scanDurationsMs.length = 0
    sendStats.count = 0
    samples.length = 1
    samples[0]!.elapsedSeconds = 0
    visibilityBeforeIdle = {
      ...visibility(),
      rendererVisibility: await web.executeJavaScript('document.visibilityState'),
    }
    measuring = true
    const begin = performance.now()
    sampleInterval = setInterval(() => void sample(), 1000)
    if (trial.smoke) {
      // Smoke drives one controlled publication; it does not measure ordinary scan frequency.
      await active.refresh()
      await drainPipeline()
    }
    await new Promise((resolve) => setTimeout(resolve, trial.durationSeconds * 1000))
    await drainPipeline()
    measuring = false
    // Capture the counters and buffers in the final CPU sample's synchronous
    // seam. Later callbacks must not enter these observations during shutdown.
    sample()
    clearInterval(sampleInterval)
    sampleInterval = null
    const end = performance.now()
    const rendererAtEnd = win.webContents.executeJavaScript('window.snapshotBench.metrics()')
    const adapterAtEnd = adapter.metrics()
    const idleAtEnd = {
      rendererSends: { count: sendStats.count, bytes: adapterAtEnd.payloadBytes },
      publicationLatencyMs: [...publicationLatencyMs],
      snapshotNotifications,
      scanDurationsMs: [...scanDurationsMs],
      adapter: adapterAtEnd,
      snapshot: active.snapshot(),
      samples: [...samples],
    }
    await captureSampling
    captureResult = await capture.stop()
    // Deep cloning is diagnostic allocation; keep it outside active profiling.
    measured = freezeMeasurement(idleAtEnd)
    visibilityAfterIdle = {
      ...visibility(),
      rendererVisibility: await web.executeJavaScript('document.visibilityState'),
    }
    const renderer = await rendererAtEnd
    if (!renderer.consumerReady || renderer.treeItems <= 0 || renderer.taskCount <= 0)
      throw new Error('Production benchmark consumers did not render fixture data')
    rendererStats = freezeMeasurement(renderer)
    snapshotDigest = measured.snapshot ? digest(JSON.stringify(measured.snapshot)) : ''
    // These counters now describe only diagnostics, never the result's idle fields.
    sendStats.count = 0
    snapshotNotifications = 0
    await drainPipeline()
    adapter.resetMetrics()
    writeFileSync(
      join(evidence, 'renderer-metrics.json'),
      JSON.stringify({ renderer, elapsedSeconds: (end - begin) / 1000 }, null, 2),
    )
    // Diagnostics keep the same non-activating visibility policy as timed idle.
    const taskPath = join(paths.vault, 'nested/tasks/task.0.md')
    const originalTask = readFileSync(taskPath, 'utf8')
    const taskCount = snapshotCount(active.snapshot()).tasks
    const diagnosticAssertions: string[] = []
    const rawMs: number[] = []
    // Pause only after idle: do not let synthetic diagnostic edits enter autosave
    // history. Scans, plugin reconciliation, IPC and real consumers still run.
    active.pause('post-idle changed-update diagnostic')
    const diagnosticHead = await active.repo.head()
    const pollPaint = (heading: string, timeoutMs: number) =>
      win!.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const heading = ${JSON.stringify(heading)};
        const deadline = performance.now() + ${timeoutMs};
        const timer = setTimeout(() => reject(new Error('Changed heading DOM/paint timed out')), ${timeoutMs});
        const visible = () => [...document.querySelectorAll('[data-planning-view] button')]
          .some(node => node.textContent?.trim() === heading && node.getClientRects().length > 0 &&
            node.getBoundingClientRect().bottom > 0 && node.getBoundingClientRect().top < innerHeight);
        const poll = () => {
          if (performance.now() > deadline) return reject(new Error('Changed heading not visible in production PlanningView before timeout'));
          if (!visible()) return setTimeout(poll, 10);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (visible()) { clearTimeout(timer); resolve(window.snapshotBench.metrics().taskCount); }
            else poll();
          }));
        };
        poll();
      })`)
    // Select an actual production PlanningView list, not the benchmark's output.
    await win.webContents.executeJavaScript(`
      [...document.querySelectorAll('[data-planning-view] [role="tab"]')]
        .find(node => node.textContent?.trim() === 'List')?.click()`)
    await pollPaint('Task 0', 5000)
    try {
      for (let index = 0; index < 5; index++) {
        const heading = `Task 0 changed ${trial.id} ${index + 1}`
        const text = originalTask.replace('# Task 0', `# ${heading}`)
        const writeStart = performance.now()
        let timer: NodeJS.Timeout | undefined
        try {
          await Promise.race([
            (async () => {
              writeFileSync(taskPath, text)
              await active!.refresh()
              await drainPipeline()
              const renderedCount = await pollPaint(
                heading,
                Math.max(1, 4900 - (performance.now() - writeStart)),
              )
              rawMs.push(performance.now() - writeStart)
              if (
                renderedCount !== taskCount ||
                snapshotCount(active!.snapshot()).tasks !== taskCount
              )
                throw new Error('Changed update altered task count')
              if (
                readFileSync(taskPath, 'utf8') !== text ||
                (await active!.repo.head()) !== diagnosticHead
              )
                throw new Error('Changed update was discarded or accidentally autosaved')
            })(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('Changed update exceeded 5000ms')), 5000)
            }),
          ])
          diagnosticAssertions.push(
            `PASS: changed update ${index + 1} visible in PlanningView after two animation frames; stable task count; no autosave/discard`,
          )
        } finally {
          clearTimeout(timer)
        }
      }
    } finally {
      writeFileSync(taskPath, originalTask)
      await active.refresh()
      await drainPipeline()
      await pollPaint('Task 0', 5000)
      if (
        readFileSync(taskPath, 'utf8') !== originalTask ||
        (await active.repo.head()) !== diagnosticHead
      )
        throw new Error('Changed-update fixture restoration failed or was autosaved')
      diagnosticAssertions.push(
        'PASS: original task restored and pipeline drained without autosave',
      )
      nativeUserChangesLatency = {
        phase: 'post-idle changed-update diagnostic',
        display: 'showInactive; unchanged visibility policy; user focus is never changed',
        metric:
          'write-start to real PlanningView DOM text plus two animation frames (includes refresh and pipeline drain)',
        rawMs,
        p95Ms: rawMs.length === 5 ? Math.max(...rawMs) : null,
        complete: rawMs.length === 5,
        assertions: diagnosticAssertions,
      }
    }
    if (trial.pilot) {
      const assertPilot = (name: string, passed: boolean) => {
        pilotAssertions.push(`${passed ? 'PASS' : 'FAIL'}: ${name}`)
        if (!passed) pilotValid = false
      }
      const unchanged = active.snapshot()!
      const beforeUnchanged = adapter.metrics()
      await adapter.onSnapshot(unchanged)
      const afterUnchanged = adapter.metrics()
      assertPilot(
        'unchanged scan follows mode send policy',
        trial.mode === 'candidate'
          ? afterUnchanged.suppressed > beforeUnchanged.suppressed
          : afterUnchanged.sent > beforeUnchanged.sent,
      )
      assertPilot(
        'plugin receives unchanged snapshot',
        afterUnchanged.pluginCallbacks.length > beforeUnchanged.pluginCallbacks.length,
      )
      const beforeForced = afterUnchanged.sent
      await adapter.onSnapshot(unchanged, true)
      assertPilot('forced identical refresh sends snapshot', adapter.metrics().sent > beforeForced)
      adapter.epochChanged()
      const beforeEpoch = adapter.metrics().sent
      await adapter.onSnapshot(unchanged)
      assertPilot('presentation epoch replays snapshot', adapter.metrics().sent > beforeEpoch)

      const notePath = join(paths.vault, 'pilot-note.md')
      const taskPath = join(paths.vault, 'task.pilot.md')
      writeFileSync(notePath, '# Pilot note\n\nBody before update.\n')
      writeFileSync(taskPath, '# Pilot task\n\nTask before update.\n')
      await active.refresh()
      await drainPipeline()
      const baselineNoteAt = active
        .snapshot()
        ?.docs.find((doc) => doc.path === 'pilot-note.md')?.updatedAt
      await new Promise((resolve) => setTimeout(resolve, 20))
      writeFileSync(notePath, '# Pilot note\n\nBody after update.\n')
      writeFileSync(taskPath, '# Pilot task\n\nTask after update.\n')
      await active.refresh()
      await drainPipeline()
      let changed = active.snapshot()!
      assertPilot(
        'body update propagates through snapshot',
        changed.docs.some(
          (doc) => doc.path === 'pilot-note.md' && doc.updatedAt !== baselineNoteAt,
        ),
      )
      const task = changed.claimed.tasks?.items.find((item) => item.path === 'task.pilot.md') as
        { description?: string } | undefined
      assertPilot(
        'task update propagates through plugin claim',
        task?.description?.includes('Task after update') === true,
      )

      tasksEnabled = false
      host.invalidate(remote)
      await host.reconcile(active, 'settings')
      await active.refresh()
      await drainPipeline()
      changed = active.snapshot()!
      assertPilot('settings update changes task claims', changed.claimed.tasks === undefined)
    }
    if (win && !win.isDestroyed())
      writeFileSync(join(evidence, 'capture.png'), (await win.capturePage()).toPNG())
    await finish()
  } catch (error) {
    await finish(error)
  }
}

function contentFingerprint(root: string): string {
  const hash = createHash('sha256')
  const walk = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === '.git') continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path, relative)
      else if (entry.isFile()) {
        hash.update(relative).update('\\0').update(readFileSync(path)).update('\\0')
      }
    }
  }
  walk(root)
  return hash.digest('hex')
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
function snapshotCount(snapshot: any) {
  return {
    documents: snapshot.docs?.length ?? 0,
    directories: snapshot.dirs?.length ?? 0,
    tasks: snapshot.claimed?.tasks?.items?.length ?? 0,
  }
}
function aggregateProcesses(samples: Array<{ processes: MetricRow[] }>) {
  const totals = new Map<
    string,
    {
      type: string
      name: string
      cpuPercentSum: number
      samples: number
      workingSetBytes: number
      privateBytes?: number
    }
  >()
  for (const sample of samples)
    for (const row of sample.processes) {
      const key = `${row.type}:${row.pid}`
      const item = totals.get(key) ?? {
        type: row.type,
        name: row.name ?? row.type,
        cpuPercentSum: 0,
        samples: 0,
        workingSetBytes: 0,
      }
      item.cpuPercentSum += row.cpuPercent
      item.samples++
      item.workingSetBytes = row.workingSetBytes
      if (row.privateBytes !== undefined) item.privateBytes = row.privateBytes
      totals.set(key, item)
    }
  return [...totals.values()].map((item) => ({
    ...item,
    averageCpuPercent: item.samples ? item.cpuPercentSum / item.samples : 0,
  }))
}

void run(root, evidence).catch((error) => {
  console.error(error)
  process.exitCode = 1
  app.exit(1)
})
