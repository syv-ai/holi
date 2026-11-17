import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { externalizeDepsPlugin } from 'electron-vite'
import { observeChild, startupDiagnostic } from './native-smoke-process.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? (await mkdtemp(join(tmpdir(), 'holi-516-evidence-'))))
const root = await mkdtemp(join(tmpdir(), 'holi-516-native-'))
let child
let childState
let log = ''
let timedOut = false
let cancelled = false
const timeoutMs = Number(process.env.HOLI_516_TIMEOUT_MS ?? 240000)
const timer = setTimeout(() => {
  timedOut = true
  signalOwnedElectron('SIGTERM')
  setTimeout(() => signalOwnedElectron('SIGKILL'), 5000).unref()
}, timeoutMs)

function signalOwnedElectron(signal) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

const cancel = () => {
  cancelled = true
  signalOwnedElectron('SIGTERM')
}
process.on('SIGINT', cancel)
process.on('SIGTERM', cancel)

try {
  await mkdir(evidence, { recursive: true })
  for (const name of ['result.json', 'failure.json', 'electron-smoke.log', 'light.png', 'dark.png'])
    await rm(join(evidence, name), { force: true })
  for (const dir of ['userData', 'sessionData', 'app-data', 'home', 'vault'])
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
    plugins: [externalizeDepsPlugin()],
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
    `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('richTextVimIO',{read:path=>ipcRenderer.invoke('rich-text-vim:read',path),write:(path,text)=>ipcRenderer.invoke('rich-text-vim:write',path,text),call:(name,input)=>{if(name==='notes.read')return ipcRenderer.invoke('rich-text-vim:read',input.path);if(name==='notes.write')return ipcRenderer.invoke('rich-text-vim:write',input.path,input.text);throw new Error('Fixture operation denied: '+name)}});`,
  )
  await writeFile(
    join(root, 'renderer', 'index.html'),
    `<!doctype html><html data-theme="light"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; connect-src 'none'"><title>Rich text Vim fixture</title><link rel="stylesheet" href="./renderer.css"></head><body><div id="root"></div><script type="module" src="./renderer.js"></script></body></html>`,
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-rich-text-vim-native-smoke-516', main: 'main.cjs' }),
  )
  const electron = createRequire(import.meta.url)('electron')
  const env = {
    ...process.env,
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    HOLI_516_ROOT: root,
    HOLI_516_EVIDENCE: evidence,
    HOLI_VAULT_ROOT: join(root, 'vault'),
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
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
  console.log(`Evidence: ${evidence}`)
} catch (error) {
  await mkdir(evidence, { recursive: true }).catch(() => undefined)
  await writeFile(
    join(evidence, 'failure.json'),
    JSON.stringify({ error: String(error), timedOut, root, log }, null, 2),
  ).catch(() => undefined)
  throw error
} finally {
  process.off('SIGINT', cancel)
  process.off('SIGTERM', cancel)
  clearTimeout(timer)
  if (child && !childState?.exit) signalOwnedElectron('SIGTERM')
  await writeFile(join(evidence, 'electron-smoke.log'), log).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
