import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
for (const name of await readdir(evidence)) {
  if (/\.(png|jpg|mp4|json|txt|log)$/.test(name) || name === 'frames')
    await rm(join(evidence, name), { recursive: true, force: true })
}
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
    '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;self&#39;; style-src &#39;self&#39; &#39;unsafe-inline&#39;; img-src data:; font-src &#39;self&#39;; connect-src &#39;none&#39;"><style>html,body,#root{height:100%;margin:0}body{font-family:system-ui,sans-serif}[hidden]{display:none!important}</style><title>Holi #542 inbox smoke</title><link rel="stylesheet" href="renderer/renderer.css"></head><body><div id="root"></div><script type="module" src="renderer/renderer.js"></script></body></html>',
  )
  await writeFile(
    join(root, 'preload.cjs'),
    `const {contextBridge,ipcRenderer}=require('electron');
const on=(channel,cb)=>{const handler=(_event,payload)=>cb(payload);ipcRenderer.on(channel,handler);return()=>ipcRenderer.removeListener(channel,handler)};
contextBridge.exposeInMainWorld('agent542',{
  onCommand:cb=>on('vault:navigate',cb),
  onEvent:cb=>on('smoke-event',cb),
  request:(action,payload)=>ipcRenderer.invoke('542-smoke',action,payload)
});`,
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
  child = spawn(electron, [root], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
  assert.equal(result.checks.length, 20)
  for (const capture of result.captures) assert((await stat(join(evidence, capture))).size > 0)
  assert.deepEqual(result.networkDenied, [])
  assert.deepEqual(result.rendererErrors, [])
  const frames = JSON.parse(await readFile(join(evidence, 'screencast.json'), 'utf8'))
  assert.equal(frames.length, result.frameCount)
  assert(frames.length > 10)
  const manifest = frames
    .map((frame, i) => {
      const duration =
        i + 1 < frames.length ? Math.max(0.001, frames[i + 1].timestamp - frame.timestamp) : 0.5
      return `file '${frame.file}'\nduration ${duration}`
    })
    .join('\n')
  await writeFile(join(evidence, 'screencast.txt'), manifest + `\nfile '${frames.at(-1).file}'\n`)
  const video = join(evidence, 'interaction.mp4')
  const ffmpeg = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      join(evidence, 'screencast.txt'),
      '-vf',
      'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      '-fps_mode',
      'vfr',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      video,
    ],
    { encoding: 'utf8' },
  )
  await writeFile(join(evidence, 'ffmpeg.log'), ffmpeg.stderr ?? '')
  assert.equal(ffmpeg.status, 0, 'ffmpeg must encode the actual screencast')
  assert((await stat(video)).size > 0)
  result.video = video
  result.videoMode =
    'actual Page.startScreencast frames; variable durations from Chromium timestamps, not a montage'
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
} finally {
  if (child && child.exitCode === null) {
    process.kill(-child.pid, 'SIGTERM')
    const exited = await Promise.race([
      closed.then(
        () => true,
        () => true,
      ),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ])
    if (!exited) {
      process.kill(-child.pid, 'SIGKILL')
      await closed.catch(() => {})
    }
  }
  try {
    await writeFile(join(evidence, 'electron-smoke.log'), log)
  } finally {
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    await rm(root, { recursive: true, force: true })
    const remains = await stat(root).then(
      () => true,
      () => false,
    )
    let processGroupAlive = false
    if (child?.pid) {
      try {
        process.kill(-child.pid, 0)
        processGroupAlive = true
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    await writeFile(
      join(evidence, 'cleanup.json'),
      JSON.stringify(
        {
          root,
          removed: !remains,
          electronPid: child?.pid,
          processGroupAlive,
          retainedEvidence: evidence,
          providerProcessesStarted: 0,
        },
        null,
        2,
      ),
    )
    assert.equal(remains, false)
    assert.equal(processGroupAlive, false)
  }
}
