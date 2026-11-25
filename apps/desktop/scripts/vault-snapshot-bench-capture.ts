import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PerformanceObserver, performance } from 'node:perf_hooks'
import { Session } from 'node:inspector'
import { WebContents } from 'electron'

const execFileAsync = promisify(execFile)

type Allocation = {
  sampledBytes: number
  elapsedSeconds: number
  gcCount: number
  gcDurationMs: number
}
type GpuSample = { at: number; utilizationPercent: number }
export type BenchmarkCapture = {
  samplePhysicalGpu(atSeconds: number): Promise<void>
  stop(): Promise<{
    allocation: { main: Allocation; renderer: Allocation }
    physicalGpu: {
      available: boolean
      source: string
      scope: 'host'
      samples: GpuSample[]
      missingReason?: string
    }
    profilingOverhead: { calibrationSeconds: number }
  }>
  dispose(): Promise<void>
}

/** Owns its WebContents cdp attachment. Call after warmup; stop at timed-window end. */
export async function startBenchmarkCapture(web: WebContents): Promise<BenchmarkCapture> {
  if (web.isDestroyed()) throw new Error('benchmark WebContents is closed')
  const cdp = web.cdp
  if (cdp.isAttached()) throw new Error('benchmark cdp is already attached')
  cdp.attach('1.3')
  const mainInspector = new Session()
  mainInspector.connect()
  let disposed = false
  let stopped = false
  const gcEvents: Array<{ start: number; end: number }> = []
  const gpuSamples: GpuSample[] = []
  const start = performance.now()
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      if (entry.entryType === 'gc')
        gcEvents.push({ start: entry.startTime, end: entry.startTime + entry.duration })
  })
  let observerEnabled = false
  let traceActive = false
  let traceEvents: Array<{ ts: number; dur?: number; name: string; pid: number }> = []
  const rendererPid = web.getOSProcessId()
  const command = (method: string, params?: object) => cdp.sendCommand(method, params)
  const mainCommand = (method: string, params?: object) =>
    new Promise<any>((resolve, reject) =>
      mainInspector.post(method, params ?? {}, (error, result) =>
        error ? reject(error) : resolve(result),
      ),
    )
  const cleanup = async () => {
    if (disposed) return
    disposed = true
    observer.disconnect()
    if (traceActive && cdp.isAttached()) {
      try {
        const result = await command('Tracing.end')
        traceEvents.push(...((result as { value?: never }).value ?? []))
      } catch {
        /* preserve original failure */
      }
      traceActive = false
    }
    if (cdp.isAttached()) cdp.detach()
    mainInspector.disconnect()
  }
  try {
    observer.observe({ entryTypes: ['gc'] })
    observerEnabled = true
    await mainCommand('HeapProfiler.enable')
    await mainCommand('HeapProfiler.startSampling', {
      samplingInterval: 128,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    })
    await command('HeapProfiler.enable')
    await command('HeapProfiler.startSampling', {
      samplingInterval: 128,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    })
    await command('Tracing.start', { categories: 'v8', transferMode: 'ReportEvents' })
    traceActive = true
  } catch (error) {
    await cleanup()
    throw new Error(`could not start benchmark profiling: ${String(error)}`)
  }
  const startedAt = performance.now()
  const samplePhysicalGpu = async (atSeconds: number) => {
    if (stopped || disposed) throw new Error('benchmark capture has stopped')
    if (
      !Number.isFinite(atSeconds) ||
      atSeconds < 0 ||
      (gpuSamples.length && atSeconds < gpuSamples[gpuSamples.length - 1]!.at)
    )
      throw new Error('invalid GPU sample timestamp')
    throw new Error(
      'host GPU sampling is unsupported by this capture build; no GPU value was recorded',
    )
  }
  return {
    samplePhysicalGpu,
    async stop() {
      if (stopped || disposed) throw new Error('benchmark capture already stopped')
      stopped = true
      const endedAt = performance.now()
      try {
        const [mainProfile, renderProfile] = (await Promise.all([
          mainCommand('HeapProfiler.stopSampling'),
          command('HeapProfiler.stopSampling'),
        ])) as [
          { profile: { samples: Array<{ size: number }> } },
          { profile: { samples: Array<{ size: number }> } },
        ]
        await Promise.all([mainCommand('HeapProfiler.disable'), command('HeapProfiler.disable')])
        const trace = (await command('Tracing.end')) as {
          traceEvents?: Array<{ ts: number; dur?: number; name: string; pid: number }>
        }
        traceActive = false
        traceEvents = trace.traceEvents ?? []
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (!observerEnabled) throw new Error('main GC observer was not enabled')
        const gc = gcEvents.filter((event) => event.start >= startedAt && event.end <= endedAt)
        const rendererGc = traceEvents
          .filter(
            (event) =>
              event.pid === rendererPid &&
              /^(MinorGC|MajorGC|GC)/.test(event.name) &&
              event.dur !== undefined,
          )
          .map((event) => ({ start: event.ts / 1000, end: (event.ts + event.dur!) / 1000 }))
          .filter((event) => event.start >= startedAt && event.end <= endedAt)
        const merge = (events: typeof rendererGc) =>
          events
            .sort((a, b) => a.start - b.start)
            .filter((event, i, all) => i === 0 || event.start >= all[i - 1]!.end)
        const mainGc = merge(gc)
        const renderGc = merge(rendererGc)
        return {
          allocation: {
            main: {
              sampledBytes: mainProfile.profile.samples.reduce(
                (sum, sample) => sum + sample.size,
                0,
              ),
              elapsedSeconds: (endedAt - startedAt) / 1000,
              gcCount: mainGc.length,
              gcDurationMs: mainGc.reduce((sum, event) => sum + event.end - event.start, 0),
            },
            renderer: {
              sampledBytes: renderProfile.profile.samples.reduce(
                (sum, sample) => sum + sample.size,
                0,
              ),
              elapsedSeconds: (endedAt - startedAt) / 1000,
              gcCount: renderGc.length,
              gcDurationMs: renderGc.reduce((sum, event) => sum + event.end - event.start, 0),
            },
          },
          physicalGpu: {
            available: gpuSamples.length > 0,
            source: 'ioreg IOAccelerator PerformanceStatistics (not runtime-verified)',
            scope: 'host',
            samples: gpuSamples,
            ...(gpuSamples.length
              ? {}
              : { missingReason: 'host GPU sampling is unsupported by this capture build' }),
          },
          profilingOverhead: { calibrationSeconds: (startedAt - start) / 1000 },
        }
      } finally {
        await cleanup()
      }
    },
    dispose: cleanup,
  }
}
