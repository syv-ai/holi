import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(
  (process.argv[2] === '--' ? process.argv[3] : process.argv[2]) ?? '/tmp/holi-566-evidence',
)
const root = await mkdtemp(join(tmpdir(), 'holi-566-native-'))
await mkdir(evidence, { recursive: true })
for (const name of [
  'result.json',
  'electron-smoke.log',
  'files-initial-light.png',
  'files-initial-dark.png',
  'file-subscribed.png',
  'folder-inheritance.png',
  'files-final-dark.png',
  'interaction.mp4',
])
  await rm(join(evidence, name), { force: true })
await rm(join(evidence, 'frames'), { recursive: true, force: true })
let child
let closed
let log = ''
let timeout
try {
  const rendererOut = join(root, 'renderer')
  await build({
    configFile: false,
    root: desktop,
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    build: {
      outDir: rendererOut,
      emptyOutDir: true,
      rollupOptions: {
        input: join(desktop, 'scripts/files-subscriptions-smoke-renderer.tsx'),
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
        input: join(desktop, 'scripts/files-subscriptions-smoke-main.ts'),
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
    '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;self&#39;; style-src &#39;self&#39; &#39;unsafe-inline&#39;; img-src data:; font-src &#39;self&#39;; connect-src &#39;none&#39;"><title>Holi file subscriptions smoke</title><link rel="stylesheet" href="renderer/renderer.css"></head><body><div id="root"></div><script type="module" src="renderer/renderer.js"></script></body></html>',
  )
  await writeFile(
    join(root, 'preload.cjs'),
    `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('holi',{trpc:(op)=>ipcRenderer.invoke('holi:trpc',op)});contextBridge.exposeInMainWorld('fileSmoke',{vaultRoot:${JSON.stringify(join(root, 'vault'))},snapshot:()=>ipcRenderer.invoke('holi:files-smoke-snapshot')});`,
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-files-subscriptions-smoke-566', main: 'main.cjs' }),
  )
  const electron = createRequire(import.meta.url)('electron')
  const home = join(root, 'home')
  await Promise.all(
    [home, join(root, 'user-data'), join(root, 'app-data'), join(root, 'session-data')].map(
      (path) => mkdir(path, { recursive: true }),
    ),
  )
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
    HOLI_566_ROOT: root,
    HOLI_566_EVIDENCE: evidence,
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
  closed = new Promise((resolveClosed, reject) => {
    child.once('error', reject)
    child.once('close', resolveClosed)
  })
  const code = await Promise.race([
    closed,
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('Electron file-subscriptions smoke timed out'))
      }, 90_000)
    }),
  ])
  assert.equal(code, 0, 'native file-subscriptions smoke failed')
  assert(!log.includes('Error occurred in handler'), 'native IPC handler failed')
  const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'))
  assert.equal(result.ok, true)
  assert.equal(result.electron.split('.')[0], '43')
  assert.deepEqual(result.networkDenied, [])
  assert.deepEqual(result.rendererErrors, [])
  for (const capture of result.captures) assert((await stat(join(evidence, capture))).size > 0)
  assert(
    result.checks.includes(
      'production-subscriptions-json-contains-only-surviving-explicit-folder-scope',
    ),
  )
  const frames = join(evidence, 'frames')
  assert(result.recordingFrames > 10, 'continuous interaction frames must be captured')
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
  assert.equal(ffmpeg.status, 0, 'ffmpeg is required to preserve the interaction recording')
  const recording = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-framerate',
      '10',
      '-i',
      join(frames, 'frame-%04d.png'),
      '-vf',
      'fps=20,scale=1100:-2:flags=lanczos',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      join(evidence, 'interaction.mp4'),
    ],
    { encoding: 'utf8' },
  )
  assert.equal(recording.status, 0, recording.stderr)
  assert((await stat(join(evidence, 'interaction.mp4'))).size > 0)
  const resolvedRoot = await realpath(root)
  assert(
    !resolvedRoot.startsWith(await realpath(evidence)),
    'runtime root must remain separate from evidence',
  )
  console.log(
    `files subscriptions native smoke: ${result.checks.length} checks passed (${result.electron})`,
  )
  console.log(`evidence: ${evidence}`)
} finally {
  clearTimeout(timeout)
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    const exited = await Promise.race([
      closed.then(
        () => true,
        () => true,
      ),
      new Promise((resolveExited) => setTimeout(() => resolveExited(false), 5_000)),
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
