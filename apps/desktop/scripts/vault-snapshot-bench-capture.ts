import { execFile } from 'node:child_process'
import { Session } from 'node:inspector'
import { PerformanceObserver, performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import type { WebContents } from 'electron'

const execFileAsync = promisify(execFile)
const samplingInterval = 32_768

type Allocation = {
  sampledBytes: number
  elapsedSeconds: number
  gcCount: number
  gcDurationMs: number
}
type Span = { start: number; end: number }
type TraceEvent = { name: string; pid: number; ts: number; dur?: number; ph: string }
type HeapProfile = { profile: { samples: Array<{ size: number }> } }
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
    profilingOverhead: {
      calibrationSeconds: number
      samplingInterval: number
      collectedObjects: boolean
    }
  }>
  dispose(): Promise<void>
}

async function readHostGpuUtilization(): Promise<number> {
  const { stdout } = await execFileAsync('ioreg', ['-a', '-r', '-c', 'IOAccelerator'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  })
  // Other IORegistry properties contain plist data values that cannot become JSON.
  // Read only the numeric counter from the OS-generated XML, rejecting multiple devices.
  const counter = /<key>Device Utilization %<\/key>\s*<(integer|real)>(-?\d+(?:\.\d+)?)<\/\1>/g
  const values = Array.from(stdout.matchAll(counter), (match) => Number(match[2]))
  if (values.length !== 1 || !Number.isFinite(values[0]) || values[0]! < 0 || values[0]! > 100)
    throw new Error('IOAccelerator physical utilization is missing or ambiguous')
  return values[0]!
}

function allocationBytes(value: HeapProfile): number {
  if (!Array.isArray(value?.profile?.samples)) throw new Error('Missing allocation samples')
  return value.profile.samples.reduce((total, sample) => {
    if (!Number.isFinite(sample.size) || sample.size < 0)
      throw new Error('Invalid allocation sample')
    return total + sample.size
  }, 0)
}

function gcSummary(events: Span[], start: number, end: number) {
  const spans = events
    .filter((e) => e.end > start && e.start < end)
    .map((e) => ({ start: Math.max(start, e.start), end: Math.min(end, e.end) }))
    .sort((a, b) => a.start - b.start)
  let duration = 0,
    previousEnd = start
  for (const span of spans) {
    duration += Math.max(0, span.end - Math.max(previousEnd, span.start))
    previousEnd = Math.max(previousEnd, span.end)
  }
  return { gcCount: spans.length, gcDurationMs: duration }
}

let calibrationSink: unknown
function allocationCanary(): void {
  calibrationSink = Array.from({ length: 20_000 }, (_, i) => ({ text: `${i}:${'x'.repeat(128)}` }))
  void calibrationSink
  calibrationSink = null
}

/** Profiles only the owned benchmark window. Calibration precedes the measured window. */
export async function startBenchmarkCapture(web: WebContents): Promise<BenchmarkCapture> {
  if (web.isDestroyed() || web.debugger.isAttached())
    throw new Error('Benchmark debugger unavailable')
  const cdp = web.debugger
  cdp.attach('1.3')
  const inspector = new Session()
  inspector.connect()
  const mainCommand = (method: string, params: object = {}) =>
    new Promise<any>((resolve, reject) => {
      inspector.post(method, params, (error, result) => (error ? reject(error) : resolve(result)))
    })
  const command = (method: string, params?: object) => cdp.sendCommand(method, params)
  const nodeGc: Span[] = []
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      if (entry.entryType === 'gc')
        nodeGc.push({ start: entry.startTime, end: entry.startTime + entry.duration })
  })
  let trace: TraceEvent[] = [],
    traceActive = false,
    disposed = false,
    stopped = false
  let tracingComplete: (() => void) | null = null
  let traceFailure: string | undefined
  const rendererPid = web.getOSProcessId()
  const onMessage = (_event: unknown, method: string, params: any) => {
    if (method === 'Tracing.dataCollected') {
      for (const event of params.value ?? []) {
        if (
          event.pid === rendererPid &&
          /^(MinorGC|MajorGC)$/.test(event.name) &&
          event.ph === 'X'
        ) {
          if (trace.length >= 100_000) traceFailure = 'GC trace exceeded bounded event capacity'
          else trace.push(event)
        }
      }
    } else if (method === 'Tracing.tracingComplete') {
      if (params.dataLossOccurred) traceFailure = 'GC trace lost data'
      tracingComplete?.()
    }
  }
  cdp.on('message', onMessage)
  const beginTrace = async () => {
    trace = []
    traceFailure = undefined
    await command('Tracing.start', {
      categories:
        'v8,devtools.timeline,disabled-by-default-v8.gc,disabled-by-default-devtools.timeline',
      transferMode: 'ReportEvents',
    })
    traceActive = true
  }
  const endTrace = async () => {
    if (!traceActive) return
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          tracingComplete = null
          reject(new Error('GC trace drain timed out'))
        }, 5000)
        tracingComplete = () => {
          clearTimeout(timer)
          tracingComplete = null
          resolve()
        }
        void command('Tracing.end').catch((error) => {
          clearTimeout(timer)
          tracingComplete = null
          reject(error)
        })
      })
    } finally {
      traceActive = false
    }
    if (traceFailure) throw new Error(traceFailure)
  }
  const rendererClock = async () => {
    const result = (await command('Performance.getMetrics')) as {
      metrics: Array<{ name: string; value: number }>
    }
    const time = result.metrics.find((m) => m.name === 'Timestamp')?.value
    if (!Number.isFinite(time)) throw new Error('Renderer monotonic clock unavailable')
    return time! * 1000
  }
  const sampling = {
    samplingInterval,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  }
  const startSampling = () =>
    Promise.all([
      mainCommand('HeapProfiler.startSampling', sampling),
      command('HeapProfiler.startSampling', sampling),
    ])
  const stopSampling = () =>
    Promise.all([
      mainCommand('HeapProfiler.stopSampling'),
      command('HeapProfiler.stopSampling'),
    ]) as Promise<[HeapProfile, HeapProfile]>
  const cleanup = async () => {
    if (disposed) return
    disposed = true
    observer.disconnect()
    let failure: unknown
    // Cancellation discards profiles. Detaching the owned sessions stops their
    // profilers without waiting to collect abandoned heap-profile data.
    try {
      await endTrace()
    } catch (error) {
      failure = error
    }
    cdp.removeListener('message', onMessage)
    if (cdp.isAttached()) cdp.detach()
    inspector.disconnect()
    if (failure) throw failure
  }
  const calibrationStart = performance.now()
  let startedAt = 0,
    rendererStart = 0
  try {
    observer.observe({ entryTypes: ['gc'] })
    await Promise.all([
      mainCommand('HeapProfiler.enable'),
      command('HeapProfiler.enable'),
      command('Performance.enable'),
    ])
    await startSampling()
    await beginTrace()
    allocationCanary()
    await command('Runtime.evaluate', {
      expression: `(() => { globalThis.__holi544AllocationCanary = Array.from({length:20000}, (_, i) => ({text: i + 'x'.repeat(128)})); delete globalThis.__holi544AllocationCanary; })()`,
    })
    await Promise.all([
      mainCommand('HeapProfiler.collectGarbage'),
      command('HeapProfiler.collectGarbage'),
    ])
    const calibration = await stopSampling()
    await endTrace()
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)))
    if (
      !nodeGc.length ||
      !trace.length ||
      calibration.some((profile) => allocationBytes(profile) <= 0)
    )
      throw new Error(
        'Allocation/GC calibration did not observe collected canary allocations and real GC events',
      )
    nodeGc.length = 0
    await beginTrace()
    await startSampling()
    rendererStart = await rendererClock()
    startedAt = performance.now()
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Capture start and cleanup failed')
    }
    throw error
  }
  const gpuSamples: GpuSample[] = []
  let gpuFailure: string | undefined
  return {
    async samplePhysicalGpu(at) {
      if (
        stopped ||
        disposed ||
        !Number.isFinite(at) ||
        at < 0 ||
        (gpuSamples.length && at <= gpuSamples.at(-1)!.at)
      )
        throw new Error('Invalid physical GPU sample lifetime or timestamp')
      try {
        gpuSamples.push({ at, utilizationPercent: await readHostGpuUtilization() })
      } catch (error) {
        gpuFailure = String(error)
        throw error
      }
    },
    async stop() {
      if (stopped || disposed) throw new Error('Capture already stopped')
      stopped = true
      const endedAt = performance.now()
      try {
        const rendererEnd = await rendererClock()
        const [mainProfile, rendererProfile] = await stopSampling()
        await endTrace()
        await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)))
        const rendererGc = trace.map((event) => {
          if (!Number.isFinite(event.ts) || !Number.isFinite(event.dur) || event.dur! < 0)
            throw new Error('Invalid GC trace span')
          return { start: event.ts / 1000, end: (event.ts + event.dur!) / 1000 }
        })
        return {
          allocation: {
            main: {
              sampledBytes: allocationBytes(mainProfile),
              elapsedSeconds: (endedAt - startedAt) / 1000,
              ...gcSummary(nodeGc, startedAt, endedAt),
            },
            renderer: {
              sampledBytes: allocationBytes(rendererProfile),
              elapsedSeconds: (rendererEnd - rendererStart) / 1000,
              ...gcSummary(rendererGc, rendererStart, rendererEnd),
            },
          },
          physicalGpu: {
            available: gpuSamples.length >= 2 && !gpuFailure,
            source: 'ioreg IOAccelerator PerformanceStatistics.Device Utilization %',
            scope: 'host',
            samples: [...gpuSamples],
            ...(gpuFailure || gpuSamples.length < 2
              ? { missingReason: gpuFailure ?? 'Fewer than two physical GPU observations' }
              : {}),
          },
          profilingOverhead: {
            calibrationSeconds: (startedAt - calibrationStart) / 1000,
            samplingInterval,
            collectedObjects: true,
          },
        }
      } finally {
        await cleanup()
      }
    },
    dispose: cleanup,
  }
}
