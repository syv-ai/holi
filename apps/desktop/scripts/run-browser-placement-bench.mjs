import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile, readFile, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { installCancellationHandlers } from './browser-placement-bench-lifecycle.mjs'
import { createOwnedProcesses } from './owned-processes.mjs'
import {
  cpuFor,
  dispersion,
  median,
  assertPlacementCounters,
} from './browser-placement-bench-analysis.mjs'
import { scenarioNames } from './browser-placement-bench-scenarios.mjs'
import { selectScenario } from './browser-placement-bench-scenarios.mjs'
import { validateTrials, terminalCounters } from './browser-placement-bench-results.mjs'
const EXPECTED_SOURCE_HASH = '4fa1cc0a0ee188d981910085e881488ddcc19592105d00c1b492a831058b5726'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { externalizeDepsPlugin } from 'electron-vite'

assert(
  process.platform !== 'win32',
  'Windows is unsupported until owned process-tree drainage is verified; refusing before build or spawn',
)
const cancellation = installCancellationHandlers()
const { cancelled } = cancellation
const ownedProcesses = createOwnedProcesses()
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}
assert(
  args.includes('--focus') && option('--focus') === 'foreground',
  '--focus foreground is required',
)
const outArg = option('--out', join(tmpdir(), `holi-547-evidence-${Date.now()}-${process.pid}`))
const out = resolve(outArg)
const seconds = Number(option('--seconds', '60'))
const warmup = Number(option('--warmup', '20'))
const repetitions = Number(option('--repetitions', '3'))
const countsOnly = args.includes('--counts')
const variant = option('--variant', 'baseline')
const scenario = option('--scenario', '')
if (scenario) selectScenario(scenario)
assert(!scenario || scenarioNames.includes(scenario), `unsupported scenario: ${scenario}`)
const selectedScenarioCount = scenario ? 1 : scenarioNames.length
assert(variant === 'baseline', '--variant supports baseline only; hybrid is rejected')
assert(Number.isFinite(seconds) && seconds >= 1 && seconds <= 3600, '--seconds must be 1..3600')
assert(Number.isFinite(warmup) && warmup >= 0 && warmup <= 600, '--warmup must be 0..600')
assert(
  Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 20,
  '--repetitions must be 1..20',
)
await mkdir(out, { recursive: false })
if (process.platform === 'darwin') {
  const concurrent = spawnSync('pgrep', ['-fl', 'holi-547-placement-runtime-'], {
    encoding: 'utf8',
  })
  assert.equal(
    concurrent.status,
    1,
    concurrent.status === 0
      ? `another placement benchmark runtime is active; leaving it untouched: ${concurrent.stdout}`
      : `could not verify benchmark process precondition: ${concurrent.stderr}`,
  )
}
const free = (await statfs(tmpdir())).bavail * (await statfs(tmpdir())).bsize
assert(free > 1024 ** 3, `insufficient free space for isolated Electron benchmark: ${free}`)
let child
let output = ''
let closed
let root
let sourceHash
const sourcePath = join(desktop, 'src/plugins/browser/renderer/browser-surface.tsx')
const expectedHash = EXPECTED_SOURCE_HASH
const fixture = join(desktop, 'scripts/browser-placement-fixture')
let renderer
const reactPlugin = react()
const tailwind = (
  await import(
    pathToFileURL(createRequire(join(desktop, 'package.json')).resolve('@tailwindcss/vite'))
  )
).default
let instrumentMatches = 0
try {
  root = await mkdtemp(join(tmpdir(), 'holi-547-placement-runtime-'))
  renderer = join(root, 'renderer')
  const source = await readFile(sourcePath, 'utf8')
  sourceHash = createHash('sha256').update(source).digest('hex')
  assert.equal(
    sourceHash,
    expectedHash,
    'BrowserSurface placement source changed; review instrumentation before updating hash',
  )
  const instrumentationPlugin = {
    name: 'placement-benchmark-instrumentation',
    enforce: 'pre',
    transform(code, id) {
      if (id.split('?')[0] !== sourcePath) return null
      if (!countsOnly) return null
      assert.equal(
        createHash('sha256').update(source).digest('hex'),
        expectedHash,
        'instrumentation source hash mismatch',
      )
      const needle =
        '      frame = requestAnimationFrame(tick)\n      const el = host.current\n      if (el === null) return\n      const r = el.getBoundingClientRect()'
      assert.equal(
        code.split(needle).length - 1,
        1,
        'expected one usePlacement callback geometry seam',
      )
      instrumentMatches++
      const overlayNeedle =
        '    if (!el.matches(OVERLAY)) continue\n    const r = el.getBoundingClientRect()'
      assert.equal(
        code.split(overlayNeedle).length - 1,
        1,
        'expected one targeted overlay rect seam',
      )
      return code
        .replace(
          needle,
          `      window.__placementBenchStats ??= { callbacks: 0, hostRects: 0, coverageScans: 0, overlayRects: 0 }\n      window.__placementBenchStats.callbacks++\n      ${variant === 'baseline' ? 'frame = requestAnimationFrame(tick)\n      ' : ''}const el = host.current\n      if (el === null) return\n      window.__placementBenchStats.hostRects++\n      const r = el.getBoundingClientRect()`,
        )
        .replace(
          overlayNeedle,
          '    if (!el.matches(OVERLAY)) continue\n    window.__placementBenchStats.overlayRects++\n    const r = el.getBoundingClientRect()',
        )
        .replace(
          'function overlaid(box: Box): boolean {\n  for (const el of document.body.children) {',
          'function overlaid(box: Box): boolean {\n  window.__placementBenchStats.coverageScans++\n  for (const el of document.body.children) {',
        )
    },
  }
  if (cancellation.interrupted)
    throw new Error(`benchmark cancelled by ${cancellation.interrupted}`)
  await build({
    configFile: false,
    base: './',
    root: fixture,
    resolve: {
      alias: [
        { find: '@/plugin-api', replacement: join(fixture, 'api.ts') },
        { find: '@', replacement: join(desktop, 'src/renderer/src') },
      ],
      dedupe: ['react', 'react-dom', 'jotai'],
    },
    esbuild: { jsx: 'automatic' },
    plugins: [reactPlugin, tailwind(), instrumentationPlugin],
    build: { outDir: renderer, emptyOutDir: true, minify: false },
  })
  const mainSource = join(desktop, 'scripts/browser-placement-bench-main.ts')
  await build({
    configFile: false,
    root: desktop,
    plugins: [externalizeDepsPlugin({ exclude: ['@holi/shared'] })],
    build: {
      ssr: true,
      target: 'node24',
      outDir: root,
      emptyOutDir: false,
      rollupOptions: {
        input: mainSource,
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'main.cjs',
          banner: `module.paths.unshift(${JSON.stringify(join(desktop, 'node_modules'))});`,
        },
      },
    },
  })
  assert.equal(
    instrumentMatches,
    countsOnly ? 1 : 0,
    'instrumentation match count differs from requested run mode',
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-browser-placement-bench', main: 'main.cjs' }),
  )
  const evidenceMeta = {
    startedAt: new Date().toISOString(),
    gitHead: await (
      await import('node:child_process')
    )
      .execFileSync('git', ['rev-parse', 'HEAD'], { cwd: desktop, encoding: 'utf8' })
      .trim(),
    sourceHash,
    variant,
    scenario: scenario || null,
    seconds,
    warmup,
    repetitions,
    preconditions: {
      freeBytesBeforeBuild: free,
      minimumFreeBytes: 1024 ** 3,
      runtimeDirectoryUnique: true,
      placementBenchmarkProcessConflict: 'none detected',
      loopbackPort: 'OS-assigned port 0; bind success asserted in Electron main',
    },
    thresholds: {
      cpuUnits: 'one-core percent (raw Electron machine-percent retained in baseline)',
      hostCpuImprovement: '>=20% and >=0.5 one-core percentage points, >3x observed noise',
      appCpuImprovement: '>=0.5 percentage points, >3x observed noise',
      regression:
        'no active CPU/GPU-process CPU regression >10% and 0.5 percentage points; memory <=5 MiB and <=5%',
      correctness: 'all placement correctness checks pass',
    },
    limitations: [
      'GPU-process CPU is not GPU utilization',
      'direct GPU utilization and energy are not available through this non-interactive benchmark',
    ],
    runMode: countsOnly ? 'placement-counts-diagnostic' : 'minimally-instrumented-resource',
    instrumentation: { matchedExactly: countsOnly ? instrumentMatches === 1 : false, sourceHash },
  }
  await writeFile(join(out, 'metadata.json'), JSON.stringify(evidenceMeta, null, 2))
  if (cancellation.interrupted)
    throw new Error(`benchmark cancelled by ${cancellation.interrupted}`)
  const electron = createRequire(import.meta.url)('electron')
  const env = {
    ...process.env,
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
    HOLI_BENCH_ROOT: root,
    HOLI_BENCH_EVIDENCE: out,
    HOLI_BENCH_RENDERER: renderer,
    HOLI_BENCH_PRELOAD: join(desktop, 'scripts/browser-display-fixture/preload.cjs'),
    HOLI_BENCH_SECONDS: String(seconds),
    HOLI_BENCH_WARMUP: String(warmup),
    HOLI_BENCH_REPETITIONS: String(repetitions),
    HOLI_BENCH_SOURCE: sourceHash,
    HOLI_BENCH_VARIANT: variant,
    HOLI_BENCH_SCENARIO: scenario,
    HOLI_BENCH_COUNTS: countsOnly ? '1' : '0',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const owned = ownedProcesses.start(electron, [root], { env })
  child = owned.child
  child.stdout.on('data', (chunk) => {
    output += chunk
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
    process.stderr.write(chunk)
  })
  closed = owned.exited.then(({ code }) => code)
  let timeout
  let code
  try {
    code = await Promise.race([
      closed,
      cancelled,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Electron placement benchmark timed out')),
          (seconds + warmup + 15) * repetitions * selectedScenarioCount * 1000 + 120000,
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
  await writeFile(join(out, 'stdout.log'), output)
  assert.equal(
    code?.code ?? code,
    0,
    `isolated Electron benchmark failed (exit ${code?.code ?? code})`,
  )
  const baseline = JSON.parse(await readFile(join(out, 'baseline.json'), 'utf8'))
  assert.equal(baseline.source, sourceHash)
  assert.equal(baseline.variant, variant)
  assert(baseline.observations.length > 0, 'no native observations collected')
  const selectedScenarios = scenario ? [scenario] : scenarioNames
  const validatedTrials = validateTrials(baseline, selectedScenarios, repetitions, countsOnly)
  const byScenario = Object.fromEntries(
    baseline.scenarios.map(({ name }) => {
      const observations = baseline.observations.filter((item) => item.phase === name)
      const groups = {
        app: observations.map((item) => cpuFor(item.appMetrics, () => true)),
        main: observations.map((item) =>
          cpuFor(item.appMetrics, (process) => process.pid === item.mainPid),
        ),
        host: observations.map((item) =>
          cpuFor(item.appMetrics, (process) => process.pid === item.shellDiagnostics?.hostPid),
        ),
        pages: observations.map((item) =>
          cpuFor(item.appMetrics, (process) => item.pagePids.includes(process.pid)),
        ),
        gpuProcess: observations.map((item) =>
          cpuFor(item.appMetrics, (process) => process.type === 'GPU'),
        ),
      }
      const cpuStats = Object.fromEntries(
        Object.entries(groups).map(([key, values]) => {
          const { median: center, mad } = dispersion(values)
          return [`${key}Cpu`, { medianPercent: center, madPercentagePoints: mad }]
        }),
      )
      const trialCpuStats = Object.fromEntries(
        [...new Set(observations.map((item) => item.trial))].map((trial) => {
          const trialObservations = observations.filter((item) => item.trial === trial)
          const processes = Object.fromEntries(
            Object.entries({
              app: () => true,
              main: (process) => process.pid === trialObservations[0]?.mainPid,
              host: (process) => process.pid === trialObservations[0]?.shellDiagnostics?.hostPid,
              pages: (process) => trialObservations[0]?.pagePids.includes(process.pid),
              gpuProcess: (process) => process.type === 'GPU',
            }).map(([role, predicate]) => {
              const values = trialObservations.map((item) => cpuFor(item.appMetrics, predicate))
              const { median: center, mad } = dispersion(values)
              return [
                role,
                { samples: values.length, medianOneCorePercent: center, madPercentagePoints: mad },
              ]
            }),
          )
          return [trial, processes]
        }),
      )
      const memoryMiB = observations.map(
        (item) =>
          item.appMetrics.reduce((sum, process) => sum + (process.memory?.workingSetSize ?? 0), 0) /
          1024,
      )
      const counterDeltasByTrial = {}
      if (countsOnly) {
        for (const trial of [...new Set(observations.map((item) => item.trial))]) {
          const terminal = terminalCounters(validatedTrials, name, repetitions)
          counterDeltasByTrial[trial] = terminal[trial]
        }
      }
      return [
        name,
        {
          samples: observations.length,
          ...cpuStats,
          perTrialCpu: trialCpuStats,
          totalMemoryWorkingSetMiBMedian: median(memoryMiB),
          totalMemoryWorkingSetMiBMax: memoryMiB.length ? Math.max(...memoryMiB) : null,
          placementCounterDeltasByTrial: countsOnly ? counterDeltasByTrial : null,
          placementTransitionMessages: baseline.placementTransitionsByScenario?.[name] ?? null,
        },
      ]
    }),
  )
  await writeFile(
    join(out, 'summary.json'),
    JSON.stringify(
      {
        schema: baseline.schema,
        variant,
        sourceHash,
        trials: repetitions,
        observations: baseline.observations.length,
        scenarios: byScenario,
        placementMessages: baseline.placementMessages,
        correctness:
          'native WebContentsView counts are asserted for every scenario; hidden and overlay detach states are included',
        runMode: countsOnly ? 'placement-counts-diagnostic' : 'minimally-instrumented-resource',
        noise:
          'per-scenario and per-trial app CPU median absolute deviation in one-core percent across per-second samples; repeatability shown by trial',
        gpuUtilization: null,
        energy: null,
      },
      null,
      2,
    ),
  )
  console.log(`Evidence: ${out}`)
} catch (error) {
  await writeFile(join(out, 'failure.txt'), `${error instanceof Error ? error.stack : error}\n`)
  throw error
} finally {
  let drainageError
  try {
    await ownedProcesses.stopAll()
    if (ownedProcesses.size !== 0) throw new Error('owned benchmark processes remain')
  } catch (error) {
    drainageError = error
  }
  if (!drainageError && root) {
    try {
      await rm(root, { recursive: true, force: true })
    } catch (error) {
      drainageError = error
    }
  }
  try {
    await writeFile(
      join(out, 'cleanup.json'),
      JSON.stringify(
        {
          runtimeRemoved: Boolean(root) && !drainageError,
          runtimeRoot: root,
          launcherPid: child?.pid ?? null,
          processGroupDrained: !drainageError,
          completedAt: new Date().toISOString(),
          failure: drainageError?.message ?? null,
        },
        null,
        2,
      ),
    )
  } finally {
    cancellation.dispose()
  }
  if (drainageError) throw new Error(`${drainageError.message}; runtime retained at ${root}`)
}
