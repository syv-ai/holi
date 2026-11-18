import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { externalizeDepsPlugin } from 'electron-vite'
import { observeChild, startupDiagnostic } from './native-smoke-process.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requestedEvidence = process.argv.slice(2).find((argument) => argument !== '--')
const evidence = requestedEvidence
  ? resolve(requestedEvidence)
  : await mkdtemp(join(tmpdir(), 'holi-516-evidence-'))
const root = await mkdtemp(join(tmpdir(), 'holi-516-native-'))
const clipboardToken = `holi-516-${randomBytes(32).toString('hex')}`
let child
let childState
let guard
let guardState
let guardLines
let guardLineQueue = []
let guardLineWaiters = []
let guardCleanup = { started: false, restoreConfirmed: false, exited: false }
let log = ''

function nextGuardStatus(timeoutMs = 10000) {
  if (guardLineQueue.length) return Promise.resolve(guardLineQueue.shift())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for clipboard guard')),
      timeoutMs,
    )
    timer.unref()
    guardLineWaiters.push((status) => {
      clearTimeout(timer)
      resolve(status)
    })
  })
}
let timedOut = false
let cancelled = false
let evidenceOwned = !requestedEvidence
let timeoutMs = Number(process.env.HOLI_516_TIMEOUT_MS ?? 240000)
let timer

function signalOwnedElectron(signal) {
  if (!child?.pid || childState?.exit) return null
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
    return null
  } catch (error) {
    if (error?.code === 'ESRCH') return null
    // EPERM on the process group must not prevent signaling the known child.
    // Never retry the group signal after the leader has exited: its id may be reused.
    if (error?.code === 'EPERM' && !childState?.exit) {
      try {
        child.kill(signal)
        return null
      } catch (fallbackError) {
        if (fallbackError?.code === 'ESRCH') return null
        return fallbackError
      }
    }
    return error
  }
}

const cancel = () => {
  cancelled = true
  signalOwnedElectron('SIGTERM')
}
process.on('SIGINT', cancel)
process.on('SIGTERM', cancel)

async function terminateOwnedProcess() {
  if (!child || !childState || childState.exit)
    return { outcome: childState?.exit ?? null, errors: [] }
  const errors = []
  const termError = signalOwnedElectron('SIGTERM')
  if (termError) errors.push(`SIGTERM: ${termError}`)
  let outcome = await Promise.race([
    childState.closed,
    new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
  ])
  if (!outcome) {
    const killError = signalOwnedElectron('SIGKILL')
    if (killError) errors.push(`SIGKILL: ${killError}`)
    outcome = await Promise.race([
      childState.closed,
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ])
  }
  return { outcome, errors }
}

async function encodeInteractionVideo() {
  const frames = join(evidence, 'frames')
  const video = join(evidence, 'interaction.mp4')
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-framerate',
      '8',
      '-i',
      join(frames, 'frame-%04d.png'),
      '-vf',
      'format=yuv420p',
      '-c:v',
      'libx264',
      '-movflags',
      '+faststart',
      video,
    ],
    { encoding: 'utf8' },
  )
  if (result.error) throw result.error
  assert.equal(result.status, 0, `ffmpeg interaction capture failed: ${result.stderr}`)
  await access(video)
  await rm(frames, { recursive: true, force: true })
}

try {
  if (process.platform !== 'darwin')
    throw new Error('Native clipboard-safe Vim acceptance is supported only on macOS')
  timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 240000
  if (requestedEvidence) {
    await mkdir(dirname(evidence), { recursive: true })
    try {
      await access(evidence)
      throw new Error(`Evidence directory already exists; choose a unique path: ${evidence}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await mkdir(evidence)
    evidenceOwned = true
  }
  for (const dir of ['userData', 'sessionData', 'app-data', 'home', 'tmp', 'vault'])
    await mkdir(join(root, dir), { recursive: true })

  await build({
    configFile: false,
    root: desktop,
    base: './',
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'rich-text-vim-disposable-file-adapter',
        enforce: 'pre',
        transform(_code, id) {
          if (id.endsWith('/src/renderer/src/lib/trpc.ts'))
            return `const call=(name,input)=>window.richTextVimIO.call(name,input);const proxy=(path=[])=>new Proxy(()=>{}, {get(_target,key){if(key==='then')return undefined;const next=[...path,String(key)];if(['query','mutate'].includes(String(key)))return input=>call(next.slice(0,-1).join('.'),input);return proxy(next)}});export const trpc=proxy();`
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
  if (cancelled) throw new Error('Native fixture cancelled during renderer build')
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
        input: join(desktop, 'scripts/rich-text-vim-native-smoke-main.ts'),
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'main.cjs',
          banner: `module.paths.unshift(${JSON.stringify(join(desktop, 'node_modules'))});`,
        },
      },
    },
  })
  if (cancelled) throw new Error('Native fixture cancelled during main build')
  await writeFile(
    join(root, 'preload.cjs'),
    `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('richTextVimIO',{read:path=>ipcRenderer.invoke('rich-text-vim:read',path),write:(path,text)=>ipcRenderer.invoke('rich-text-vim:write',path,text),call:(name,input)=>{if(name==='notes.read')return ipcRenderer.invoke('rich-text-vim:read',input.path);if(name==='notes.write')return ipcRenderer.invoke('rich-text-vim:write',input.path,input.text);if(name==='comments.read')return ipcRenderer.invoke('rich-text-vim:comments','read');if(name==='comments.list')return ipcRenderer.invoke('rich-text-vim:comments','list',undefined,input.path);if(name==='comments.write')return ipcRenderer.invoke('rich-text-vim:comments','write',input.text);if(name==='github.fileContributors'||name==='history.list')return Promise.resolve([]);if(name.startsWith('fixture.'))return ipcRenderer.invoke('rich-text-vim:fixture',name.slice(8));throw new Error('Fixture operation denied: '+name)}});`,
  )
  await writeFile(
    join(root, 'renderer', 'index.html'),
    `<!doctype html><html data-theme="light"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; connect-src 'none'"><title>Rich text Vim fixture</title><link rel="stylesheet" href="./renderer.css"></head><body><div id="root"></div><script type="module" src="./renderer.js"></script></body></html>`,
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-rich-text-vim-native-smoke-516', main: 'main.cjs' }),
  )
  const guardExecutable = join(root, 'clipboard-guard')
  const compiledGuard = spawnSync(
    '/usr/bin/swiftc',
    [join(desktop, 'scripts/rich-text-vim-clipboard-guard.swift'), '-o', guardExecutable],
    { encoding: 'utf8' },
  )
  if (compiledGuard.error) throw compiledGuard.error
  assert.equal(
    compiledGuard.status,
    0,
    `Clipboard guard compilation failed: ${compiledGuard.stderr}`,
  )
  guard = spawn(guardExecutable, [clipboardToken], { stdio: ['pipe', 'pipe', 'pipe'] })
  guardState = observeChild(guard)
  guardCleanup.started = true
  guard.stdin.on('error', () => {})
  guardLines = createInterface({ input: guard.stdout })
  guardLines.on('line', (line) => {
    let status
    try {
      status = JSON.parse(line)
    } catch {
      return
    }
    if (status.event === 'ready' || status.event === 'restored') {
      const waiter = guardLineWaiters.shift()
      if (waiter) waiter(status)
      else guardLineQueue.push(status)
    }
  })
  guard.stderr.on('data', (chunk) => {
    // The helper is designed to emit only sanitized status; retain no native diagnostics.
    if (chunk.length) process.stderr.write('Clipboard guard emitted a diagnostic.\n')
  })
  const ready = await Promise.race([
    nextGuardStatus(),
    guardState.closed.then((outcome) => {
      throw new Error(`Clipboard guard exited before readiness: ${JSON.stringify(outcome)}`)
    }),
  ])
  assert.equal(ready.event, 'ready', 'Clipboard guard did not snapshot the pasteboard')
  console.log(
    `Clipboard guard ready: ${JSON.stringify({ itemCount: ready.itemCount, typeCount: ready.typeCount })}`,
  )

  const electron = createRequire(import.meta.url)('electron')
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
    HOLI_516_ROOT: root,
    HOLI_516_EVIDENCE: evidence,
    HOLI_516_CLIPBOARD_TOKEN: clipboardToken,
    HOLI_VAULT_ROOT: join(root, 'vault'),
    NODE_PATH: join(desktop, 'node_modules'),
  }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [root, '--remote-debugging-port=0'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  childState = observeChild(child)
  child.stdout.on('data', (chunk) => {
    log += chunk
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    log += chunk
    process.stderr.write(chunk)
  })
  timer = setTimeout(() => {
    timedOut = true
    signalOwnedElectron('SIGTERM')
  }, timeoutMs)
  const outcome = await Promise.race([
    childState.closed,
    new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ timeout: true }), timeoutMs)
      timeout.unref()
    }),
  ])
  if (outcome?.timeout || timedOut || cancelled)
    throw new Error(startupDiagnostic('rich-text Vim acceptance fixture', childState, log))
  assert.equal(outcome.code, 0, `Electron fixture exited ${outcome.code}; ${log}`)
  const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'))
  assert.equal(result.ok, true, 'Electron did not write successful acceptance evidence')
  assert(result.interactionFrames > 0, 'No native interaction frames were captured')
  assert(Array.isArray(result.nativeAssertions), 'Structured native results are missing')
  const scenario = (name) => {
    const found = result.nativeAssertions.find((entry) => entry.scenario === name)
    assert(found, `Missing structured native result: ${name}`)
    return found
  }
  const deletion = scenario('comment deletion')
  assert.equal(deletion.rangeAfterDelete, null)
  assert.equal(deletion.persistedAnchor?.quote, 'alpha')
  const change = scenario('comment change')
  assert.equal(change.displayedRange?.text, 'omega')
  assert.equal(change.persistedAnchor?.quote, 'alpha')
  assert.equal(scenario('host hints').noteAfterEscape, 'alpha beta')
  assert.equal(scenario('find and Escape').findClosed, true)
  assert.equal(scenario('visual lock reset').contentAfterLockedOperator, 'alpha beta')
  assert.equal(scenario('buffer freeze and thaw').contentAfterStaleMotion, 'alpha beta')
  assert.equal(scenario('hidden retained view').contentWhileHidden, 'alpha beta')
  assert.equal(scenario('live document path and remote A-B-A').oldResultDiscarded, true)
  assert(result.visualEvidence?.selectedText, 'Screenshots lack a real native selection')
  assert.deepEqual(result.visualEvidence.themes, ['light', 'dark'])
  await access(join(evidence, 'light.png'))
  await access(join(evidence, 'dark.png'))
  await encodeInteractionVideo()
  console.log(`Evidence: ${evidence}`)
} catch (error) {
  if (evidenceOwned) {
    await mkdir(evidence, { recursive: true }).catch(() => undefined)
    await writeFile(
      join(evidence, 'failure.json'),
      JSON.stringify({ error: String(error), timedOut, cancelled, root, log }, null, 2),
    ).catch(() => undefined)
  }
  throw error
} finally {
  process.off('SIGINT', cancel)
  process.off('SIGTERM', cancel)
  clearTimeout(timer)
  const processTermination = await terminateOwnedProcess()
  const processExit = processTermination?.outcome ?? null
  let guardExit = null
  if (guard) {
    try {
      if (guard.exitCode === null && guard.signalCode === null) {
        guard.stdin.write('restore\n')
        const restored = await nextGuardStatus()
        assert.equal(restored.event, 'restored', 'Clipboard guard did not confirm restoration')
        assert.equal(restored.verified, true, 'Clipboard guard could not verify a safe final state')
        guardCleanup.restoreConfirmed = true
        guardCleanup.restoration = {
          restored: restored.restored,
          preservedExternalChange: restored.preservedExternalChange,
          unchanged: restored.unchanged,
          itemCount: restored.itemCount,
          typeCount: restored.typeCount,
          verified: restored.verified,
        }
      }
    } catch (error) {
      guardCleanup.restoreError = String(error)
      guard.stdin.end()
      try {
        const fallback = await nextGuardStatus(5000)
        if (fallback.event === 'restored' && fallback.verified === true) {
          guardCleanup.restoreConfirmed = true
          guardCleanup.restoration = {
            restored: fallback.restored,
            preservedExternalChange: fallback.preservedExternalChange,
            unchanged: fallback.unchanged,
            itemCount: fallback.itemCount,
            typeCount: fallback.typeCount,
            verified: fallback.verified,
          }
        }
      } catch (fallbackError) {
        guardCleanup.fallbackRestoreError = String(fallbackError)
      }
    }
    try {
      guardExit = await Promise.race([
        guardState.closed,
        new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
      ])
      if (!guardExit) {
        guard.kill('SIGKILL')
        guardExit = await Promise.race([
          guardState.closed,
          new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
        ])
      }
      guardCleanup.exited = guardExit !== null
    } catch (error) {
      guardCleanup.exitError = String(error)
    }
  }
  if (evidenceOwned)
    await writeFile(join(evidence, 'electron-smoke.log'), log).catch(() => undefined)
  const electronTerminated = !child || processExit !== null
  const guardTerminated = !guardCleanup.started || guardCleanup.exited
  let rootRemoved = false
  if (electronTerminated && guardTerminated) {
    await rm(root, { recursive: true, force: true }).catch((error) => {
      guardCleanup.rootRemovalError = String(error)
    })
    try {
      await access(root)
    } catch (error) {
      rootRemoved = error.code === 'ENOENT'
    }
  }
  guardLines?.close()
  if (evidenceOwned) {
    const cleanup = {
      isolatedRootRemoved: rootRemoved,
      electronTerminated,
      electronExit: processExit,
      electronTerminationErrors: processTermination?.errors ?? [],
      clipboardGuard: guardCleanup,
    }
    for (const name of ['result.json', 'failure.json']) {
      const path = join(evidence, name)
      try {
        const record = JSON.parse(await readFile(path, 'utf8'))
        record.cleanup = cleanup
        await writeFile(path, JSON.stringify(record, null, 2))
      } catch {
        // Keep whichever record exists when setup failed early.
      }
    }
  }
  if (!guardCleanup.restoreConfirmed && guardCleanup.started)
    throw new Error(
      `Clipboard guard restoration was not confirmed: ${JSON.stringify(guardCleanup)}`,
    )
  if (!guardCleanup.exited && guardCleanup.started)
    throw new Error(`Clipboard guard did not exit cleanly: ${JSON.stringify(guardCleanup)}`)
  if (!electronTerminated)
    throw new Error(
      `Owned Electron process did not terminate; retaining isolated root: ${JSON.stringify({ root, errors: processTermination?.errors })}`,
    )
  if (processTermination?.errors?.length)
    throw new Error(
      `Electron termination reported errors: ${JSON.stringify(processTermination.errors)}`,
    )
  if (!rootRemoved) throw new Error(`Isolated native-smoke root remains after cleanup: ${root}`)
}
