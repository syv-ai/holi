import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32')
  throw new Error('native frame-addressing smoke requires POSIX owned process groups')

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requestedEvidence = process.argv[2] === '--' ? process.argv[3] : process.argv[2]
const evidence = resolve(
  requestedEvidence ?? join(tmpdir(), `holi-670-${process.pid}-${Date.now()}`),
)
const root = join(tmpdir(), `holi-670-run-${process.pid}-${Date.now()}`)
const crossServer = createServer((request, response) => {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy':
      "default-src 'none'; script-src 'unsafe-inline'; frame-src http://127.0.0.1:* http://localhost:*",
  })
  response.end(
    request.url === '/child/cross'
      ? `<!doctype html><body>cross-origin child<iframe id="cross-nested" name="cross-nested" src="http://127.0.0.1:${crossServer.address().port}/grandchild"></iframe></body>`
      : '<!doctype html><body>cross-origin grandchild</body>',
  )
})
const checks = [
  'nested-frame-tree',
  'exact-native-context-correspondence',
  'immediate-parent-owner',
  'owner-oopif-grandchild',
  'cross-site-oopif-under-oopif',
  'inserted-frame-owner-matrix-from-independent-source-identity',
  'reordering-reversed-observed-dom-order-after-document-readiness',
  'reordering-preserves-independent-complete-owner-matrix',
  'pre-dispatch target has exact owner',
  'native frame observes positive control from isolated execution world',
  'pre-dispatch-cross-process-navigation-rejects-and-replacement-dom-stays-clear',
  'four-adapter-twelve-capture-nested-oopif-worlds-remain-bounded-with-exact-owners',
  'new-capture-lease-works-without-world-growth-after-revocation',
  'detached-navigation-revokes-old-lease-through-broker',
  'detached-removal-recreate-has-fresh-owner-and-no-old-lease',
  'late-world-response-fresh-adapter-owner-valid',
  'allocated-world-delayed-response-cancelled-without-stale-handler-command',
  'oopif-allocated-world-delayed-response-recovery',
  'nested-post-allocation-cancel-churn-keeps-one-native-world',
  'oopif-post-allocation-cancel-churn-keeps-one-native-world',
  'forged-marker-isolation',
  'private-state-inaccessible',
  'pending-resolution-revocation',
  'pending-evaluation-revocation',
  'cross-process-navigation-unique-context-addressing',
  'pending-evaluation-rejects-on-oopif-detach',
  'pending-evaluation-rejects-on-replacement',
  'navigation-replacement-and-presentation-aba',
  'trusted-native-input',
]
let cancelled = false
let child
let childGroup = false
let childGroupDrained = true
let buildProcess
let buildGroup = false
let buildGroupDrained = true
let buildTerminationRecorded = false
let ownedBuildPid
let childExit
let log = ''
let crossListening = false
let rootCreated = false
let evidenceCreated = false
let logReceiptWritten = false
let shutdownPromise
let cancelRun
let phase = 'setup'
const signals = []
const cancellation = new Promise((_, reject) => {
  cancelRun = reject
})
void cancellation.catch(() => {})
const errors = []
const boundedLog = (chunk) => {
  log = (log + chunk.toString()).slice(-256_000)
  process.stdout.write(chunk)
}
const cancel = (signal) => {
  signals.push({ signal, phase })
  process.stdout.write(`signal received: ${signal} during ${phase}\n`)
  if (cancelled) return
  cancelled = true
  const error = new Error(`received ${signal}`)
  errors.push(error)
  cancelRun(error)
}
process.on('SIGINT', cancel)
process.on('SIGTERM', cancel)
const ensureActive = () => {
  if (cancelled) throw new Error('native smoke cancelled')
}
const active = (promise) => Promise.race([promise, cancellation])

async function shutdown() {
  if (shutdownPromise) return shutdownPromise
  phase = 'cleanup'
  shutdownPromise = (async () => {
    const attempt = async (label, work) => {
      try {
        await work()
      } catch (error) {
        errors.push(new Error(`${label}: ${error}`))
      }
    }
    await attempt('build shutdown', async () => {
      if (buildProcess) {
        await killOwned(buildProcess, buildGroup)
        buildTerminationRecorded = true
      }
      buildGroupDrained = true
    })
    await attempt('child shutdown', stopChild)
    await attempt('server shutdown', async () => {
      if (!crossListening) return
      crossServer.closeAllConnections()
      await new Promise((resolveClose, reject) =>
        crossServer.close((error) => (error ? reject(error) : resolveClose())),
      )
      crossListening = false
    })
    await attempt('log receipt', async () => {
      if (evidenceCreated) {
        await writeFile(join(evidence, 'electron-smoke.log'), log, { flag: 'w' })
        logReceiptWritten = true
      }
    })
    await attempt('sandbox cleanup', async () => {
      if (rootCreated) {
        await rm(root, { recursive: true, force: true })
        rootCreated = false
      }
    })
    // Keep the supervisor alive and its signal handlers installed until cleanup has settled.
    if (signals.length) await new Promise((resolveWait) => setTimeout(resolveWait, 750))
  })()
  return shutdownPromise
}

try {
  ensureActive()
  await mkdir(evidence, { recursive: false })
  evidenceCreated = true
  ensureActive()
  await mkdir(root, { recursive: false })
  rootCreated = true
  ensureActive()
  // Setup itself is drained before finally can start cleanup. Active process waits race cancellation.
  phase = 'build'
  await runBuild()
  ensureActive()
  crossServer.on('error', (error) => {
    if (cancelled) return
    errors.push(new Error(`loopback server failed: ${error.message}`))
    cancelled = true
    cancelRun(error)
  })
  await active(
    withTimeout(
      new Promise((resolveListen, reject) => {
        const onError = (error) => {
          crossServer.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          crossServer.off('error', onError)
          resolveListen()
        }
        crossServer.once('error', onError)
        crossServer.once('listening', onListening)
        ensureActive()
        crossServer.listen(0, '127.0.0.1')
        crossListening = true
      }),
      10_000,
      'loopback server listen timed out',
    ),
  )
  ensureActive()
  const crossAddress = crossServer.address()
  assert(crossAddress && typeof crossAddress === 'object')
  const output = join(root, 'bundle')
  await mkdir(output, { recursive: true })
  ensureActive()
  await writeFile(
    join(output, 'package.json'),
    JSON.stringify({ name: 'holi-670-frame-addressing', main: 'main.cjs' }),
  )
  ensureActive()
  const electron = createRequire(import.meta.url)('electron')
  const env = {
    ...process.env,
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
    HOLI_670_ROOT: root,
    HOLI_670_EVIDENCE: evidence,
    HOLI_670_CROSS_ENTRY: `http://localhost:${crossAddress.port}`,
  }
  delete env.ELECTRON_RUN_AS_NODE
  ensureActive()
  phase = 'electron-fixture'
  child = spawn(electron, ['--site-per-process', output], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  childGroup = true
  childGroupDrained = false
  child.stdout.on('data', boundedLog)
  child.stderr.on('data', boundedLog)
  childExit = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', (code, signal) => resolveExit({ code, signal }))
  })
  const exit = await active(withTimeout(childExit, 120_000, 'Electron fixture timed out'))
  assert.equal(exit.code, 0, `Electron fixture failed (${exit.signal ?? exit.code})`)
  const proof = JSON.parse(await readFile(join(evidence, 'proof.json'), 'utf8'))
  assert.equal(proof.ok, true)
  for (const name of checks)
    assert(proof.checks.includes(name), `missing named fixture check: ${name}`)
  assert.equal(
    new Set(proof.checks).size,
    proof.checks.length,
    'fixture check names must be unique',
  )
} catch (error) {
  if (!errors.includes(error)) errors.push(error)
} finally {
  await shutdown()
  process.off('SIGINT', cancel)
  process.off('SIGTERM', cancel)
  phase = 'finished'
}

if (errors.length) {
  if (evidenceCreated)
    await writeFile(
      join(evidence, 'failure.json'),
      JSON.stringify(
        {
          ok: false,
          errors: errors.map((error) => String(error)),
          cancellation: cancelled
            ? errors.find((error) => /^received SIG/.test(error.message))?.message
            : null,
          signals,
          log,
          cleanup: {
            serverClosed: !crossListening,
            sandboxRemoved: !rootCreated,
            buildGroupDrained,
            buildTerminationRecorded,
            ownedBuildPid,
            buildGroupDrainedAfterSignal: buildGroupDrained,
            childGroupDrained,
            logReceiptWritten,
          },
        },
        null,
        2,
      ),
    ).catch(() => {})
  throw new AggregateError(errors, 'frame addressing native smoke failed')
}
await writeFile(
  join(evidence, 'result.json'),
  JSON.stringify(
    {
      ok: true,
      checks,
      electron: createRequire(import.meta.url)('electron/package.json').version,
      cleanup: {
        buildGroupDrained,
        childGroupDrained,
        serverClosed: !crossListening,
        profileAndBundleRemoved: !rootCreated,
        logReceiptWritten,
      },
    },
    null,
    2,
  ),
)
console.log(`native frame addressing smoke: ${checks.length} named checks passed; cleanup verified`)

async function runBuild() {
  ensureActive()
  const buildScript = join(root, 'build.mjs')
  const require = createRequire(import.meta.url)
  const vitePath = require.resolve('vite')
  const electronVitePath = require.resolve('electron-vite')
  const banner = `module.paths.unshift(${JSON.stringify(join(desktop, 'node_modules'))});`
  await writeFile(
    buildScript,
    `
    import { build } from ${JSON.stringify(vitePath)}
    import { externalizeDepsPlugin } from ${JSON.stringify(electronVitePath)}
    import { existsSync, writeFileSync } from 'node:fs'
    import { setTimeout as delay } from 'node:timers/promises'
    const testGate = process.env.HOLI_670_TEST_BUILD_GATE
    const checkpoint = testGate ? {
      name: 'holi-670-controlled-vite-build-start',
      async buildStart() {
        writeFileSync(testGate + '.started', JSON.stringify({ pid: process.pid }))
        while (!existsSync(testGate + '.release')) await delay(10)
      }
    } : null
    await build({ configFile: false, root: ${JSON.stringify(desktop)}, plugins: [externalizeDepsPlugin(), ...(checkpoint ? [checkpoint] : [])], build: {
      ssr: true, target: 'node24', outDir: ${JSON.stringify(join(root, 'bundle'))}, emptyOutDir: true,
      rollupOptions: { input: ${JSON.stringify(join(desktop, 'scripts/browser-frame-addressing-smoke.ts'))}, external: ['electron'], output: {
        format: 'cjs', entryFileNames: 'main.cjs', banner: ${JSON.stringify(banner)}
      } },
    } })
  `,
  )
  ensureActive()
  // The build runs in an isolated process group, so shutdown can reap its descendants.
  const processRef = spawn(process.execPath, [buildScript], {
    cwd: desktop,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  buildProcess = processRef
  ownedBuildPid = processRef.pid
  const grouped = true
  buildGroup = grouped
  buildGroupDrained = false
  let output = ''
  processRef.stdout.on('data', (chunk) => {
    output = (output + chunk).slice(-64_000)
    boundedLog(chunk)
  })
  processRef.stderr.on('data', (chunk) => {
    output = (output + chunk).slice(-64_000)
    boundedLog(chunk)
  })
  const ended = new Promise((resolveEnd, rejectEnd) => {
    processRef.once('error', rejectEnd)
    processRef.once('close', (code, signal) =>
      code === 0
        ? resolveEnd()
        : rejectEnd(new Error(`fixture build exited ${signal ?? code}: ${output}`)),
    )
  })
  await active(withTimeout(ended, 120_000, 'fixture build timed out'))
  await killOwned(processRef, grouped)
  buildGroupDrained = true
  buildProcess = undefined
}

async function stopChild() {
  const processRef = child
  if (!processRef) return
  await killOwned(processRef, childGroup)
  if (childExit)
    await withTimeout(
      childExit.catch(() => {}),
      5_000,
      'Electron child close wait timed out',
    )
  childGroupDrained = true
}
async function killOwned(processRef, grouped) {
  if (!processRef?.pid) return
  if (!grouped) throw new Error('owned process group was not registered')
  try {
    process.kill(-processRef.pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  if (processRef.exitCode === null && processRef.signalCode === null)
    await withTimeout(
      new Promise((resolveExit) => processRef.once('close', resolveExit)),
      5_000,
      'owned child close wait timed out',
    )
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      process.kill(-processRef.pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error(`owned process group survived: ${processRef.pid}`)
}
function withTimeout(promise, milliseconds, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(message))
      }, milliseconds)
    }),
  ]).finally(() => clearTimeout(timer))
}
