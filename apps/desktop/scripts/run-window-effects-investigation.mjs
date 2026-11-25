#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, loadavg, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { externalizeDepsPlugin } from 'electron-vite'
import { observeChild } from './native-smoke-process.mjs'
import { compareWindowEffects } from './window-effects-analysis.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? '')
const phase = process.argv[3] ?? 'pilot'
assert(
  process.argv[2] && ['pilot', 'compare'].includes(phase),
  'Usage: node run-window-effects-investigation.mjs <new-evidence-dir> [pilot|compare] [pilot-dir]',
)
assert.equal(process.platform, 'darwin')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n')
const run = (file, args, options = {}) =>
  spawnSync(file, args, {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
const source = run('git', ['rev-parse', 'HEAD'], { cwd: desktop }).stdout.trim()
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length
    ? sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2
    : null
}
function percentile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : null
}
await mkdir(evidence)
const root = await mkdtemp(join(tmpdir(), 'holi-543-'))
const protocol = {
  source,
  phase,
  pairs: ['AB', 'BA', 'AB', 'BA', 'AB'],
  warmupSeconds: phase === 'pilot' ? 30 : 180,
  steadySeconds: phase === 'pilot' ? 30 : 120,
  activitySeconds: 30,
  recoverySeconds: 30,
  intervalSeconds: 1,
  thresholdBytes: 64 * 1024 * 1024,
  thresholdFraction: 0.15,
  requiredPairs: 4,
  attribution:
    'Process ledger sums are not deduplicated system memory. GPU utilisation and WindowServer observations are global. RSS is not physical footprint. Missing counters are unavailable, never zero.',
  limitations: [
    'WindowServer physical footprint/allocation access requires privileges unavailable to this run.',
    'Production DocumentView is used, not the entire authenticated vault/plugin application.',
  ],
}
let active
let cancelled = false
let cleanupFailed = false
process.on('SIGINT', () => {
  cancelled = true
})
process.on('SIGTERM', () => {
  cancelled = true
})
function checkCancelled() {
  if (cancelled) throw new Error('Investigation cancelled')
}
function metric(pid) {
  const result = run(join(root, 'metrics'), [String(pid)])
  try {
    return JSON.parse(result.stdout)
  } catch {
    return { pid, unavailable: true, reason: result.error?.code ?? 'collector failed' }
  }
}
function gpu() {
  const result = run('/usr/sbin/ioreg', ['-r', '-c', 'AGXAccelerator', '-d', '1'])
  const out = {}
  for (const name of [
    'Device Utilization %',
    'Tiler Utilization %',
    'Renderer Utilization %',
    'In use system memory',
    'Alloc system memory',
  ]) {
    const match = result.stdout?.match(new RegExp('"' + name + '"=(\\d+)'))
    if (match) out[name] = Number(match[1])
  }
  return Object.keys(out).length ? out : { unavailable: true }
}
function seconds(text) {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text]
  return (
    Number(days) * 86400 +
    clock
      .split(':')
      .reverse()
      .reduce((n, x, i) => n + Number(x) * 60 ** i, 0)
  )
}
const wsPid = Number(run('pgrep', ['-x', 'WindowServer']).stdout.trim())
function windowServer() {
  if (!Number.isInteger(wsPid) || wsPid <= 0) return { unavailable: true }
  const result = run('ps', ['-p', String(wsPid), '-o', 'time=,rss='])
    .stdout.trim()
    .split(/\s+/)
  return result.length === 2
    ? { pid: wsPid, cpuSeconds: seconds(result[0]), rssBytes: Number(result[1]) * 1024 }
    : { unavailable: true }
}
function gone(pid, birth) {
  const current = metric(pid)
  return (
    current.errno === 3 ||
    (Number.isFinite(birth) &&
      Number.isFinite(current.startAbstime) &&
      current.startAbstime !== birth)
  )
}
async function stop(instance) {
  const errors = []
  if (!instance.observer.exit) {
    try {
      await instance.call('quit')
    } catch (error) {
      errors.push(String(error))
    }
    await Promise.race([instance.observer.closed, sleep(5000)])
    if (!instance.observer.exit) {
      // The unreaped original child is still the group leader; no PID rediscovery.
      try {
        process.kill(-instance.child.pid, 'SIGTERM')
      } catch (error) {
        if (error.code !== 'ESRCH') errors.push(String(error))
      }
      await Promise.race([instance.observer.closed, sleep(5000)])
    }
    if (!instance.observer.exit) {
      try {
        process.kill(-instance.child.pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') errors.push(String(error))
      }
      await Promise.race([instance.observer.closed, sleep(5000)])
    }
  }
  for (let i = 0; i < 50; i++) {
    if ([...instance.identities].every(([pid, birth]) => gone(pid, birth))) break
    await sleep(100)
  }
  const remaining = [...instance.identities]
    .filter(([pid, birth]) => !gone(pid, birth))
    .map(([pid]) => pid)
  instance.lines.close()
  const confirmed = !!instance.observer.exit && remaining.length === 0
  await json(join(evidence, instance.name + '-cleanup.json'), {
    confirmed,
    remaining,
    errors,
    exit: instance.observer.exit,
    runtime: confirmed ? null : instance.profile,
  })
  if (confirmed) await rm(instance.profile, { recursive: true, force: true })
  else {
    cleanupFailed = true
    throw new Error('Owned runtime cleanup unconfirmed; profile retained: ' + instance.profile)
  }
}
async function launch(mode, name) {
  const profile = join(root, name)
  for (const dir of ['userData', 'sessionData', 'app-data', 'home', 'tmp', 'vault'])
    await mkdir(join(profile, dir), { recursive: true })
  await cp(join(root, 'preload.cjs'), join(profile, 'preload.cjs'))
  await cp(join(root, 'renderer'), join(profile, 'renderer'), { recursive: true })
  const child = spawn(
    createRequire(import.meta.url)('electron'),
    [join(root, 'main.cjs'), ...(mode === 'opaque' ? ['--opaque'] : [])],
    {
      cwd: profile,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        HOME: join(profile, 'home'),
        TMPDIR: join(profile, 'tmp'),
        HOLI_WINDOW_EFFECTS_ROOT: profile,
        NODE_PATH: join(desktop, 'node_modules'),
      },
    },
  )
  const observer = observeChild(child)
  const pending = new Map()
  let id = 0,
    diagnostic = ''
  let readyResolve, readyReject
  const ready = new Promise((a, b) => {
    readyResolve = a
    readyReject = b
  })
  const instance = {
    child,
    observer,
    profile,
    name,
    identities: new Map(),
    lines: createInterface({ input: child.stdout }),
    call(command, value) {
      return new Promise((resolve, reject) => {
        const key = ++id
        const timer = setTimeout(() => {
          pending.delete(key)
          reject(new Error('Fixture command timeout: ' + command))
        }, 30000)
        pending.set(key, { resolve, reject, timer })
        child.stdin.write(JSON.stringify({ id: key, command, value }) + '\n', (error) => {
          if (error) {
            clearTimeout(timer)
            pending.delete(key)
            reject(error)
          }
        })
      })
    },
  }
  active = instance
  const birth = metric(child.pid)
  instance.identities.set(child.pid, birth.startAbstime ?? null)
  child.stdin.on('error', () => {})
  child.stderr.on('data', (chunk) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-4000)
  })
  instance.lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.event === 'ready') readyResolve(message)
    if (message.event === 'error') readyReject(new Error(message.error))
    const request = pending.get(message.id)
    if (request) {
      clearTimeout(request.timer)
      pending.delete(message.id)
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.result)
    }
  })
  observer.closed.then((exit) => {
    readyReject(new Error('Fixture exited: ' + JSON.stringify(exit) + ' ' + diagnostic))
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('Fixture closed'))
    }
    pending.clear()
  })
  let timer
  try {
    const result = await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Fixture startup timeout: ' + diagnostic)), 60000)
      }),
    ])
    instance.ready = result
    return instance
  } finally {
    clearTimeout(timer)
  }
}
async function sample(instance, stage, previous) {
  const started = performance.now()
  const state = await instance.call('state')
  const processes = state.processes.map(({ pid, type }) => ({ type, ...metric(pid) }))
  for (const item of processes) {
    const old = instance.identities.get(item.pid)
    if (Number.isFinite(item.startAbstime)) {
      assert(
        old === undefined || old === null || old === item.startAbstime,
        'Owned PID identity changed',
      )
      instance.identities.set(item.pid, item.startAbstime)
    } else if (!instance.identities.has(item.pid) && item.errno !== 3)
      instance.identities.set(item.pid, null)
  }
  const at = performance.now()
  const ws = windowServer()
  let cpuPercent = null
  if (previous) {
    let ns = 0,
      complete = true
    for (const item of processes) {
      const old = previous.processes.find(
        (x) => x.pid === item.pid && x.startAbstime === item.startAbstime,
      )
      if (!old || item.errno || item.unavailable) complete = false
      else ns += item.userTimeNs + item.systemTimeNs - old.userTimeNs - old.systemTimeNs
    }
    if (complete) cpuPercent = (ns / ((at - previous.at) * 1e6)) * 100
  }
  const wsCpuPercent =
    previous && Number.isFinite(ws.cpuSeconds) && Number.isFinite(previous.ws.cpuSeconds)
      ? ((ws.cpuSeconds - previous.ws.cpuSeconds) / ((at - previous.at) / 1000)) * 100
      : null
  const gpuValues = gpu()
  const complete =
    processes.length > 0 && processes.every((x) => Number.isFinite(x.physicalFootprint))
  return {
    stage,
    at,
    iso: new Date().toISOString(),
    state,
    processes,
    ws,
    gpu: gpuValues,
    load: loadavg(),
    collectorMilliseconds: performance.now() - started,
    physicalFootprint: complete ? processes.reduce((sum, x) => sum + x.physicalFootprint, 0) : null,
    cpuPercent,
    wsCpuPercent,
  }
}
async function trial(mode, name) {
  const instance = await launch(mode, name)
  const samples = []
  try {
    for (const [stage, duration] of [
      ['warmup', protocol.warmupSeconds],
      ['steady', protocol.steadySeconds],
      ...(phase === 'compare'
        ? [
            ['activity', 30],
            ['recovery', 30],
          ]
        : []),
    ]) {
      for (let second = 0; second < duration; second++) {
        checkCancelled()
        const start = performance.now()
        if (stage === 'activity') await instance.call('activity', second)
        if (stage === 'recovery' && second === 0) await instance.call('restore')
        samples.push(await sample(instance, stage, samples.at(-1)))
        await sleep(Math.max(0, 1000 - (performance.now() - start)))
      }
      console.log(JSON.stringify({ name, stage, completed: duration }))
    }
    await json(join(evidence, name + '-samples.json'), samples)
    const latest = await instance.call('state')
    for (const item of latest.processes) {
      const identity = metric(item.pid)
      if (!identity.startAbstime) continue
      instance.identities.set(item.pid, identity.startAbstime)
      const map = run('/usr/bin/vmmap', ['-summary', String(item.pid)], { timeout: 20000 })
      await writeFile(
        join(evidence, `${name}-${item.type}-${item.pid}-vmmap.txt`),
        map.stdout + map.stderr,
      )
    }
    for (const theme of ['light', 'dark']) {
      await instance.call('capture', theme)
      await cp(join(instance.profile, theme + '.png'), join(evidence, name + '-' + theme + '.png'))
    }
    const steady = samples.filter((x) => x.stage === 'steady')
    const columns = {
      physicalFootprint: steady.map((x) => x.physicalFootprint),
      cpuPercent: steady.map((x) => x.cpuPercent),
      gpuPercent: steady.map((x) => x.gpu['Device Utilization %']),
      wsCpuPercent: steady.map((x) => x.wsCpuPercent),
    }
    const summary = {
      name,
      mode,
      effect: instance.ready.state.effect,
      ready: instance.ready,
      valid: samples.every(
        (x) =>
          x.physicalFootprint !== null &&
          x.state.focused &&
          x.state.visible &&
          x.state.editor.readable &&
          x.state.editor.editable &&
          x.state.display.id === instance.ready.state.display.id &&
          x.state.display.scaleFactor === instance.ready.state.display.scaleFactor,
      ),
      steady: Object.fromEntries(
        Object.entries(columns).map(([key, values]) => [
          key,
          { median: median(values), p05: percentile(values, 0.05), p95: percentile(values, 0.95) },
        ]),
      ),
      observedLedgerPeak: Math.max(...samples.map((x) => x.physicalFootprint ?? 0)),
      cpuPeaksAreNotSteady: true,
    }
    await json(join(evidence, name + '-summary.json'), summary)
    return summary
  } finally {
    if (samples.length) await json(join(evidence, name + '-samples.json'), samples)
    await stop(instance)
    active = undefined
  }
}
try {
  if (phase === 'compare') {
    assert(process.argv[4], 'Compare requires a completed pilot directory')
    const pilot = JSON.parse(await readFile(join(resolve(process.argv[4]), 'summary.json'), 'utf8'))
    assert(
      pilot.phase === 'pilot' && pilot.source === source && pilot.valid && pilot.noiseTolerances,
      'Pilot must be valid and from the identical source head',
    )
    protocol.frozenTolerances = pilot.noiseTolerances
    protocol.pilot = resolve(process.argv[4])
    protocol.pilotEffect = pilot.result.effect
  }
  await json(join(evidence, 'protocol.json'), protocol)
  await json(join(evidence, 'environment.json'), {
    source,
    os: release(),
    arch: process.arch,
    load: loadavg(),
    windowServerPhysical: wsPid > 0 ? metric(wsPid) : { unavailable: true },
    globalGpu: gpu(),
    windowServer: windowServer(),
  })
  await build({
    configFile: false,
    root: desktop,
    base: './',
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'fixture-io',
        enforce: 'pre',
        transform(_code, id) {
          if (id.endsWith('/src/renderer/src/lib/trpc.ts'))
            return `const call=(n,i)=>window.richTextVimIO.call(n,i);const p=(a=[])=>new Proxy(()=>{}, {get(_,k){if(k==='then')return;const b=[...a,String(k)];if(['query','mutate'].includes(String(k)))return i=>call(b.slice(0,-1).join('.'),i);return p(b)}});export const trpc=p();`
          return null
        },
      },
    ],
    build: {
      target: 'chrome140',
      outDir: join(root, 'renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: join(desktop, 'scripts/rich-text-vim-native-smoke.tsx'),
        output: { entryFileNames: 'renderer.js', assetFileNames: 'renderer.[ext]' },
      },
    },
  })
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
        input: join(desktop, 'scripts/window-effects-investigation-main.ts'),
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
    join(root, 'preload.cjs'),
    `const {contextBridge,ipcRenderer}=require('electron');const read=p=>ipcRenderer.invoke('rich-text-vim:read',p),write=(p,t)=>ipcRenderer.invoke('rich-text-vim:write',p,t);contextBridge.exposeInMainWorld('richTextVimIO',{read,write,call:(n,i)=>{if(n==='notes.read')return read(i.path);if(n==='notes.write')return write(i.path,i.text);if(n==='subscriptions.readForDisplay')return read(i.path).then(text=>({text,receipt:null}));if(n==='subscriptions.acknowledgeDisplay')return Promise.resolve(false);if(n==='comments.read'||n==='comments.list')return ipcRenderer.invoke('rich-text-vim:comments',n==='comments.read'?'read':'list');if(n==='github.fileContributors'||n==='history.list')return Promise.resolve([]);throw Error('Fixture operation denied: '+n)}});`,
  )
  await writeFile(
    join(root, 'renderer/index.html'),
    `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';img-src data:;font-src 'self';connect-src 'none'"><link rel="stylesheet" href="./renderer.css"><title>Holi window-effects fixture</title></head><body><div id="root"></div><script type="module" src="./renderer.js"></script></body></html>`,
  )
  const compiler = run(
    'clang',
    [
      '-O2',
      '-Wall',
      '-Wextra',
      join(desktop, 'scripts/window-effects-metrics.c'),
      '-o',
      join(root, 'metrics'),
    ],
    { timeout: 60000 },
  )
  assert.equal(compiler.status, 0, compiler.stderr)
  if (phase === 'pilot') {
    const result = await trial('native', 'pilot-native')
    const noiseTolerances = Object.fromEntries(
      ['cpuPercent', 'gpuPercent', 'wsCpuPercent'].map((key) => {
        const value = result.steady[key]
        return [
          key,
          Number.isFinite(value.p95) && Number.isFinite(value.p05)
            ? Math.max(1, value.p95 - value.p05)
            : null,
        ]
      }),
    )
    await json(join(evidence, 'summary.json'), {
      phase,
      source,
      valid: result.valid,
      noiseTolerances,
      result,
      status: 'pilot only; no comparison or optimization conclusion',
    })
  } else {
    const pairs = []
    for (let i = 0; i < protocol.pairs.length; i++) {
      const outcomes = {}
      for (const label of protocol.pairs[i])
        outcomes[label] = await trial(label === 'A' ? 'native' : 'opaque', `pair-${i + 1}-${label}`)
      pairs.push({ outcomes })
      await json(join(evidence, 'pairs.json'), pairs)
    }
    const result = compareWindowEffects(pairs, protocol.frozenTolerances, protocol.pilotEffect)
    await json(join(evidence, 'summary.json'), {
      phase,
      source,
      ...result,
      limitations: protocol.limitations,
    })
  }
} finally {
  if (active) {
    try {
      await stop(active)
      active = undefined
    } catch (error) {
      cleanupFailed = true
      console.error(String(error))
    }
  }
  await json(join(evidence, 'cleanup.json'), {
    confirmed: !active && !cleanupFailed,
    runtime: active || cleanupFailed ? root : null,
  })
  if (!active && !cleanupFailed) await rm(root, { recursive: true, force: true })
}
