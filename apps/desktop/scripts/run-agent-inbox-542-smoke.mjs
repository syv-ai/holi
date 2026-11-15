import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? '/tmp/holi-542-evidence')
const root = await mkdtemp(join(tmpdir(), 'holi-542-smoke-'))
await mkdir(evidence, { recursive: true })
for (const name of [
  'result.json',
  'failure.txt',
  'electron-smoke.log',
  'terminal-light.png',
  'terminal-dark.png',
  'interaction.mp4',
])
  await rm(join(evidence, name), { force: true })
let child
let closed
let log = ''
try {
  await build({
    configFile: false,
    root: desktop,
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    build: {
      outDir: join(root, 'renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: join(desktop, 'scripts/agent-inbox-542-smoke-renderer.tsx'),
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
        input: join(desktop, 'scripts/agent-inbox-542-smoke-main.ts'),
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
    '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;self&#39;; style-src &#39;self&#39; &#39;unsafe-inline&#39;; img-src data:; font-src &#39;self&#39;; connect-src &#39;none&#39;"><title>Holi #542 inbox smoke</title><link rel="stylesheet" href="renderer/renderer.css"></head><body><div id="root"></div><script type="module" src="renderer/renderer.js"></script></body></html>',
  )
  await writeFile(
    join(root, 'preload.cjs'),
    `const {contextBridge,ipcRenderer}=require('electron'); const on=(c,fn)=>{const h=(_e,p)=>fn(p);ipcRenderer.on(c,h);return()=>ipcRenderer.removeListener(c,h)}; contextBridge.exposeInMainWorld('agent542',{onCommand:(fn)=>on('vault:navigate',fn),onInbox:(fn)=>on('smoke-inbox',fn),request:(a,p)=>ipcRenderer.invoke('542-smoke',a,p),capture:(n)=>ipcRenderer.invoke('542-smoke','capture',n),clickBanner:(t)=>ipcRenderer.invoke('542-smoke','banner-callback',t),setTheme:(t)=>{document.documentElement.setAttribute('data-theme',t)},pushPty:(id,data)=>ipcRenderer.send('542-smoke-pty',{id,data})});`,
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-agent-inbox-542-smoke', main: 'main.cjs' }),
  )
  const electron = createRequire(import.meta.url)('electron')
  const env = {
    ...process.env,
    HOLI_542_ROOT: root,
    HOLI_542_EVIDENCE: evidence,
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
  }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [root], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => {
    log += chunk
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    log += chunk
    process.stderr.write(chunk)
  })
  closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  let timeout
  const code = await Promise.race([
    closed,
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        child.kill()
        reject(new Error('Electron smoke timed out'))
      }, 120_000)
    }),
  ]).finally(() => clearTimeout(timeout))
  assert.equal(code, 0, 'Electron 43 issue #542 smoke failed')
  const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'))
  assert.equal(result.ok, true)
  assert.equal(result.electron.split('.')[0], '43')
  assert(result.checks.length >= 4)
  for (const capture of result.captures) assert((await stat(join(evidence, capture))).size > 0)
  assert.deepEqual(result.networkDenied, [])
  assert.deepEqual(result.rendererErrors, [])
  const video = join(evidence, 'interaction.mp4')
  const ffmpeg = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-loop',
      '1',
      '-t',
      '1',
      '-i',
      join(evidence, 'inbox-light.png'),
      '-loop',
      '1',
      '-t',
      '1',
      '-i',
      join(evidence, 'inbox-dark.png'),
      '-loop',
      '1',
      '-t',
      '1',
      '-i',
      join(evidence, 'inbox-session-opened.png'),
      '-filter_complex',
      '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p',
      '-movflags',
      '+faststart',
      video,
    ],
    { encoding: 'utf8' },
  )
  if (ffmpeg.status === 0) {
    result.video = video
    result.videoMode = 'three captured UI states, encoded as a short review montage'
  } else result.video = null
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    const exited = await Promise.race([
      closed.then(
        () => true,
        () => true,
      ),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ])
    if (!exited) {
      child.kill('SIGKILL')
      await closed.catch(() => {})
    }
  }
  try {
    await writeFile(join(evidence, 'electron-smoke.log'), log)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
