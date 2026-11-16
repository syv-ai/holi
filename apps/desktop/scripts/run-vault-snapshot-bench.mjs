import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createWriteStream } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  utimes,
  readFile,
  cp,
  copyFile,
  readdir,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { analyzePairs, validatePairs, sourceVersion } from './vault-snapshot-bench-analysis.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = process.argv.slice(2)
const pilot = cli.includes('--pilot')
const evidence = resolve(
  cli.includes('--') ? cli[cli.indexOf('--') + 1] : '/tmp/holi-544-verification-20261116',
)
const full = { warmupSeconds: 30, durationSeconds: 180 }
const short = { warmupSeconds: 5, durationSeconds: 35 }
const sizes = { small: { notes: 100, tasks: 20 }, large: { notes: 5000, tasks: 2000 } }
const safeEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|GITHUB|^GH_|^AWS_|^AZURE_|^GOOGLE_|^CLAUDE_|^CODEX_|^GIT_CONFIG_|SSH_AUTH_SOCK|GIT_ASKPASS)/i.test(
        name,
      ),
  ),
)
const protocol = {
  issue: 544,
  revision: 3,
  sourceVersion: sourceVersion(),
  workloadAmendment: {
    original: { notes: 10000, tasks: 2000 },
    reason:
      'The original 12000-file pilot exceeds the macOS spawn file-action descriptor range; baseline fails with EBADF before valid measurement. Use a supported 7000-file workload without changing watcher behavior or benefit thresholds.',
    evidence: 'consumers-pilot/large/pair-1/baseline/electron.log and fd-repro.json',
    upstream: [
      'https://github.com/libuv/libuv/issues/5204',
      'https://github.com/paulmillr/chokidar/issues/1385',
    ],
    appliesBeforeFullStudy: true,
  },
  mode: pilot ? 'pilot-not-gate-evidence' : 'full-gate-run',
  sizes,
  trialsPerSize: pilot ? 1 : 5,
  trial: pilot ? short : full,
  sequence: 'paired baseline/candidate; order alternates by pair',
  thresholds: {
    cpu: 'primary large workload ONLY: >=20% relative and >=0.30 app CPU-seconds/minute reduction, paired 95% CI supporting each; small is a control, not a benefit veto; normalize every trial using actual sample elapsed seconds before mean and CI',
    payload: '>=90% redundant serialized IPC-payload proxy avoidance in both sizes',
    latency:
      'both sizes: five sequential real task heading writes after timed idle, write-start through refresh, plugin pipeline, actual visible PlanningView DOM and two animation frames; 5s timeout each, restore fixture; compare per-trial changed-update p95; material regression requires BOTH >=10% AND >=20ms',
    memory: 'both sizes, steady and peak RSS: material regression requires BOTH >=5% AND >=10MiB',
    gpu: 'both sizes: GPU PID-row CPU-seconds/minute material regression requires BOTH >=10% AND >=0.03; steady/peak GPU RSS requires BOTH >=5% AND >=10MiB; no helper-process count increase; raw CPU/RSS observables only, no hardware GPU claim',
    regressionClassification:
      'pass if either upper95 bound is below its material margin; fail if lower95 bounds meet BOTH margins; otherwise inconclusive; unknown samples never pass',
    overall:
      'large benefit alone plus both-size guardrails; fail for confidently insufficient large benefit at either threshold or material guardrail failure; uncertain/insufficient evidence never becomes a no-benefit conclusion',
  },
  fixture:
    'fixed deterministic synthetic notes/tasks, fixed mtimes/commit dates, isolated local bare origins and clones; no network, user hooks, or credentials',
  caveats: [
    'Pilot is not gate evidence.',
    'rendererSends.bytes is a serialized payload proxy, not actual wire bytes.',
    'No hardware GPU claim.',
  ],
}
const owned = {
  runnerPid: process.pid,
  evidence,
  startedAt: new Date().toISOString(),
  trialRoots: [],
  children: [],
  removedRoots: [],
  cleanupErrors: [],
}
let root
let success = false
let interrupted = null
let currentChild = null
let stopSignalResolve
const stopSignal = new Promise((resolveSignal) => {
  stopSignalResolve = resolveSignal
})
const saveLedger = async () => {
  await writeFile(join(evidence, 'owned-roots.json'), JSON.stringify(owned, null, 2))
}
const recordCleanupError = (message) => owned.cleanupErrors.push(message)
const onSignal = (signal) => {
  interrupted = signal
  stopSignalResolve(signal)
  if (currentChild) terminateOwned(currentChild).catch((error) => recordCleanupError(String(error)))
}
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)

function signalGroup(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return true
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
      return false
    }
  }
  if (child.exitCode === null && child.signalCode === null) return child.kill(signal)
  return false
}

async function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      cleanup()
      resolveExit(false)
    }, milliseconds)
    const done = () => {
      cleanup()
      resolveExit(true)
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.removeListener('close', done)
      child.removeListener('error', done)
    }
    child.once('close', done)
    child.once('error', done)
  })
}

async function processGroupAlive(child) {
  if (process.platform === 'win32' || !child.pid) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function waitForGroupGone(child, milliseconds) {
  const deadline = Date.now() + milliseconds
  while (await processGroupAlive(child)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  return true
}

async function terminateOwned(child) {
  signalGroup(child, 'SIGTERM')
  await waitForExit(child, 10_000)
  if (process.platform !== 'win32' && child.pid) {
    if (await waitForGroupGone(child, 10_000)) return
    signalGroup(child, 'SIGKILL')
    await waitForExit(child, 5_000)
    if (!(await waitForGroupGone(child, 5_000)))
      throw new Error(`Owned process group ${child.pid} remains alive after SIGKILL`)
  } else if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    if (!(await waitForExit(child, 5_000)))
      throw new Error(`Owned child ${child.pid} did not exit after SIGKILL`)
  }
}

const git = (args, cwd, env) =>
  new Promise((resolveGit, reject) => {
    const process = spawn('git', args, { cwd, env, stdio: 'ignore' })
    process.once('error', reject)
    process.once('close', (code, signal) =>
      code === 0
        ? resolveGit()
        : reject(Error(`git ${args.join(' ')} exited code=${code} signal=${signal}`)),
    )
  })

async function makeFixture(vault, size) {
  const fixed = new Date('2020-01-01T00:00:00.000Z')
  await mkdir(join(vault, '.holi/settings'), { recursive: true })
  await mkdir(join(vault, '.holi/settings'), { recursive: true })
  await writeFile(join(vault, '.holi/settings/app.yaml'), 'version: 1\n')
  await writeFile(join(vault, '.holi/settings/icons.yaml'), '{}\n')
  for (let i = 0; i < size.notes; i++) {
    const path = join(vault, `nested/${String(i % 100).padStart(3, '0')}/note-${i}.md`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `---\ntitle: Note ${i}\n---\n\nDeterministic fixture body ${i}.\n`)
    await utimes(path, fixed, fixed)
  }
  for (let i = 0; i < size.tasks; i++) {
    const path = join(vault, `nested/tasks/task.${i}.md`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `---\nstatus: open\n---\n\n# Task ${i}\n\nDeterministic task ${i}.\n`)
    await utimes(path, fixed, fixed)
  }
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else {
        const relative = absolute
          .slice(vault.length + 1)
          .split('\\')
          .join('/')
        const bytes = await readFile(absolute)
        files.push({
          path: relative,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
      }
    }
  }
  await walk(vault)
  const notes = files.filter((file) => /\/note-\d+\.md$/.test(file.path)).length
  const tasks = files.filter((file) => /\/task\.\d+\.md$/.test(file.path)).length
  if (notes !== size.notes || tasks !== size.tasks)
    throw new Error(
      `Fixture count mismatch: notes=${notes}/${size.notes}, tasks=${tasks}/${size.tasks}`,
    )
  return {
    notes,
    tasks,
    files,
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  }
}

async function runTrial({ electron, rendererOut, root, evidenceDir, sizeName, size, pair, mode }) {
  const trialRoot = join(root, `${sizeName}-${pair}-${mode}`)
  owned.trialRoots.push({ path: trialRoot, state: 'allocated' })
  await saveLedger()
  await mkdir(trialRoot, { recursive: true })
  const bare = join(trialRoot, 'origin.git')
  const vault = join(trialRoot, 'vault')
  const isolatedHome = join(trialRoot, 'home')
  await mkdir(evidenceDir, { recursive: true })
  const gitEnv = {
    ...safeEnv,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_DATA_HOME: join(isolatedHome, '.local/share'),
    XDG_CACHE_HOME: join(isolatedHome, '.cache'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Snapshot Bench',
    GIT_AUTHOR_EMAIL: 'bench@localhost',
    GIT_COMMITTER_NAME: 'Snapshot Bench',
    GIT_COMMITTER_EMAIL: 'bench@localhost',
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
  }
  await mkdir(isolatedHome, { recursive: true })
  await git(['init', '--bare', bare], trialRoot, gitEnv)
  await git(['clone', bare, vault], trialRoot, gitEnv)
  const fixture = await makeFixture(vault, size)
  await git(['-C', vault, 'config', 'core.hooksPath', '/dev/null'], trialRoot, gitEnv)
  await git(['-C', vault, 'config', 'user.name', 'Snapshot Bench'], trialRoot, gitEnv)
  await git(['-C', vault, 'config', 'user.email', 'bench@localhost'], trialRoot, gitEnv)
  await git(['-C', vault, 'add', '.'], trialRoot, gitEnv)
  await git(['-C', vault, 'commit', '-m', 'deterministic snapshot fixture'], trialRoot, gitEnv)
  await git(['-C', vault, 'push', '-u', 'origin', 'HEAD'], trialRoot, gitEnv)
  await writeFile(join(evidenceDir, 'fixture-manifest.json'), JSON.stringify(fixture, null, 2))
  await mkdir(join(trialRoot, 'renderer'), { recursive: true })
  await cp(rendererOut, join(trialRoot, 'renderer'), { recursive: true })
  for (const file of ['main.cjs', 'renderer.html', 'preload.cjs', 'package.json'])
    await copyFile(join(root, file), join(trialRoot, file))
  const config = pilot ? short : full
  const env = {
    ...safeEnv,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: join(isolatedHome, 'AppData/Roaming'),
    LOCALAPPDATA: join(isolatedHome, 'AppData/Local'),
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_DATA_HOME: join(isolatedHome, '.local/share'),
    XDG_CACHE_HOME: join(isolatedHome, '.cache'),
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    HOLI_544_ROOT: trialRoot,
    HOLI_544_EVIDENCE: evidenceDir,
    HOLI_544_MODE: mode,
    HOLI_544_TRIAL: JSON.stringify({
      id: `${sizeName}-${pair}-${mode}`,
      mode,
      size: sizeName,
      ...config,
      pilot,
    }),
  }
  const log = createWriteStream(join(evidenceDir, 'electron.log'), { flags: 'w' })
  const child = spawn(electron, [trialRoot], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  currentChild = child
  const childRecord = {
    pid: child.pid ?? null,
    processGroup: process.platform === 'win32' ? null : (child.pid ?? null),
    trialRoot,
    mode,
    size: sizeName,
    pair,
    startedAt: new Date().toISOString(),
    exitCode: null,
    signal: null,
    timedOut: false,
  }
  owned.children.push(childRecord)
  await saveLedger()
  child.stdout.on('data', (chunk) => {
    log.write(chunk)
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    log.write(chunk)
    process.stderr.write(chunk)
  })
  let spawnError
  child.once('error', (error) => {
    spawnError = error
  })
  const timeoutMs = (config.warmupSeconds + config.durationSeconds + 120) * 1000
  const outcome = await Promise.race([
    new Promise((resolveExit) =>
      child.once('close', (code, signal) => resolveExit({ code, signal })),
    ),
    new Promise((resolveTimeout) => {
      const timer = setTimeout(() => resolveTimeout({ timeout: true }), timeoutMs)
      timer.unref()
    }),
    stopSignal.then((signal) => ({ interrupted: signal })),
  ])
  if (outcome.timeout || outcome.interrupted || spawnError)
    childRecord.timedOut = Boolean(outcome.timeout)
  await terminateOwned(child)
  childRecord.terminationVerified = true
  const exit =
    child.exitCode !== null || child.signalCode !== null
      ? { code: child.exitCode, signal: child.signalCode }
      : outcome
  childRecord.exitCode = exit.code ?? null
  childRecord.signal = exit.signal ?? null
  childRecord.finishedAt = new Date().toISOString()
  currentChild = null
  log.end()
  await new Promise((resolveLog) => log.once('finish', resolveLog))
  await saveLedger()
  if (outcome.interrupted) throw new Error(`Interrupted by ${outcome.interrupted}`)
  if (spawnError) throw new Error(`Unable to start Electron: ${spawnError.message}`)
  if (outcome.timeout)
    throw new Error(`Trial timed out after ${timeoutMs}ms: ${sizeName}/${pair}/${mode}`)
  const resultPath = join(evidenceDir, 'result.json')
  let result
  try {
    result = JSON.parse(await readFile(resultPath, 'utf8'))
  } catch {
    throw new Error(
      `Missing or invalid result.json for ${sizeName}/${pair}/${mode}; code=${exit.code}; signal=${exit.signal}`,
    )
  }
  await writeFile(
    join(evidenceDir, 'process-exit.json'),
    JSON.stringify(
      { exitCode: exit.code, signal: exit.signal, ok: result.ok, timedOut: false },
      null,
      2,
    ),
  )
  if (
    exit.code !== 0 ||
    exit.signal ||
    result.ok !== true ||
    !Number.isFinite(result.scans) ||
    result.scans < 1 ||
    !result.rendererSends ||
    !Number.isFinite(result.rendererSends.count) ||
    !Number.isFinite(result.rendererSends.bytes) ||
    !result.snapshotCounts ||
    !Number.isFinite(result.snapshotCounts.documents) ||
    !Array.isArray(result.verifiedModules) ||
    !['openActiveVault', 'createPluginHost', 'tasksMain'].every((module) =>
      result.verifiedModules.includes(module),
    ) ||
    !result.rendererStats ||
    !result.counterFlags?.genuineScans ||
    !result.counterFlags?.genuineRendererStats ||
    !result.adapter ||
    !result.samples?.length ||
    !Number.isFinite(result.cpuSeconds)
  )
    throw new Error(`Trial missing genuine measurements or failed: ${sizeName}/${pair}/${mode}`)
  return { mode, result, fixture }
}

try {
  root = await mkdtemp(join(tmpdir(), 'holi-544-run-'))
  await mkdir(evidence, { recursive: true })
  owned.root = root
  await writeFile(join(evidence, 'protocol.json'), JSON.stringify(protocol, null, 2), {
    flag: 'wx',
  })
  await saveLedger()
  const require = createRequire(import.meta.url)
  const electron = require('electron')
  const rendererOut = join(root, 'renderer-build')
  await build({
    configFile: false,
    root: desktop,
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    build: {
      outDir: rendererOut,
      emptyOutDir: true,
      rollupOptions: {
        input: join(desktop, 'scripts/vault-snapshot-bench-renderer.tsx'),
        output: { entryFileNames: 'renderer.js', assetFileNames: 'renderer.[ext]' },
      },
    },
  })
  await build({
    configFile: false,
    root: desktop,
    build: {
      ssr: true,
      target: 'node24',
      outDir: root,
      emptyOutDir: false,
      rollupOptions: {
        input: join(desktop, 'scripts/vault-snapshot-bench-main.ts'),
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'main.cjs',
          banner: `module.paths.unshift(${JSON.stringify(join(desktop, 'node_modules'))});`,
        },
      },
    },
  })
  await writeFile(
    join(root, 'renderer.html'),
    '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:; font-src \'self\'; connect-src \'none\'"><link rel="stylesheet" href="renderer/renderer.css"></head><body><div id="root"></div><script type="module" src="renderer/renderer.js"></script></body></html>',
  )
  await writeFile(
    join(root, 'preload.cjs'),
    `const{contextBridge,ipcRenderer}=require('electron');const sub=c=>cb=>{const f=(_e,v)=>cb(v);ipcRenderer.on(c,f);return()=>ipcRenderer.removeListener(c,f)};contextBridge.exposeInMainWorld('holi',{vault:{onSnapshot:sub('vault:snapshot'),onSyncState:sub('vault:sync'),onHeldBack:sub('vault:heldback'),onCommitted:sub('vault:committed'),onOpen:sub('vault:open'),onNavigate:sub('vault:navigate'),onLocate:sub('vault:locate'),located:v=>ipcRenderer.send('vault:located',v)},plugin:{on:(id,cb)=>{const c='plugin:'+id;const f=(_e,v)=>cb(v);ipcRenderer.on(c,f);return()=>ipcRenderer.removeListener(c,f)}},trpc:op=>ipcRenderer.invoke('snapshot-bench:rpc',op)});`,
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-snapshot-bench', main: 'main.cjs' }),
  )
  const results = []
  const trialsPerSize = pilot ? 1 : 5
  for (const [sizeName, size] of Object.entries(sizes)) {
    for (let pair = 1; pair <= trialsPerSize; pair++) {
      if (interrupted) throw new Error(`Interrupted by ${interrupted}`)
      const order = pair % 2 === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
      const trials = []
      for (const mode of order) {
        const dir = join(evidence, sizeName, `pair-${pair}`, mode)
        trials.push(
          await runTrial({
            electron,
            rendererOut,
            root,
            evidenceDir: dir,
            sizeName,
            size,
            pair,
            mode,
          }),
        )
        await rm(trials.at(-1).fixture ? owned.trialRoots.at(-1).path : '', {
          recursive: true,
          force: true,
        })
        owned.trialRoots.at(-1).state = 'removed'
        owned.removedRoots.push(owned.trialRoots.at(-1).path)
        await saveLedger()
      }
      results.push({ size: sizeName, pair, trials })
      await writeFile(join(evidence, 'trials.json'), JSON.stringify(results, null, 2))
    }
  }
  const validation = validatePairs(results, pilot)
  if (!validation.valid)
    throw new Error(`Paired result validation failed: ${validation.problems.join('; ')}`)
  const analysis = analyzePairs(results, { pilot })
  await writeFile(
    join(evidence, pilot ? 'pilot-result.json' : 'analysis.json'),
    JSON.stringify(analysis, null, 2),
  )
  success = true
} catch (error) {
  recordCleanupError(
    `run failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  )
  throw error
} finally {
  if (currentChild) {
    try {
      await terminateOwned(currentChild)
    } catch (error) {
      owned.processGroupsVerified = false
      recordCleanupError(`child group termination failed: ${error}`)
    }
    currentChild = null
  }
  const groupUnverified = owned.processGroupsVerified === false
  if (root && !groupUnverified) {
    try {
      await rm(root, { recursive: true, force: true })
      owned.removedRoots.push(root)
      owned.runtimeRootRemoved = true
    } catch (error) {
      recordCleanupError(`runtime root removal failed: ${error}`)
    }
  } else if (root) owned.runtimeRootRemoved = false
  owned.success = success
  owned.completedAt = new Date().toISOString()
  try {
    await writeFile(join(evidence, 'cleanup.json'), JSON.stringify(owned, null, 2))
  } catch (error) {
    console.error(`Could not persist cleanup evidence: ${error}`)
  }
  process.removeListener('SIGINT', onSignal)
  process.removeListener('SIGTERM', onSignal)
}
