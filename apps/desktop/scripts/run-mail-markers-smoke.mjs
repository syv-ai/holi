import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(desktop, '../..')
const evidence = resolve(process.argv[2] ?? '/tmp/holi-464/native')
const root = await mkdtemp(join(tmpdir(), 'holi-464-native-'))
await mkdir(evidence, { recursive: true })
await rm(join(evidence, 'frames'), { recursive: true, force: true })
for (const name of ['result.json', 'electron-smoke.log', 'light.png', 'dark.png'])
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
        input: join(desktop, 'scripts/mail-markers-smoke-renderer.tsx'),
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
        input: join(desktop, 'scripts/mail-markers-smoke-main.ts'),
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
    '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;self&#39;; style-src &#39;self&#39; &#39;unsafe-inline&#39;; img-src data:; font-src &#39;self&#39;; connect-src &#39;none&#39;"><title>Holi marker smoke</title><link rel="stylesheet" href="renderer/renderer.css"></head><body><div id="root"></div><script type="module" src="renderer/renderer.js"></script></body></html>',
  )
  await writeFile(
    join(root, 'preload.cjs'),
    `const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('markerSmoke', { run: (op) => ipcRenderer.invoke('holi-marker-smoke', op) });`,
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-mail-markers-smoke-464', main: 'main.cjs' }),
  )
  const electron = createRequire(import.meta.url)('electron')
  const env = {
    ...process.env,
    HOLI_464_ROOT: root,
    HOLI_464_EVIDENCE: evidence,
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
      }, 90_000)
    }),
  ]).finally(() => clearTimeout(timeout))
  assert.equal(code, 0, 'native mail marker smoke failed')
  assert(!log.includes('Error occurred in handler'), 'native IPC handler failed')
  const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'))
  assert.equal(result.ok, true)
  assert.equal(result.electron.split('.')[0], '43')
  assert(result.captures.includes('connections-light.png'))
  assert(result.captures.includes('connections-dark.png'))
  assert(result.captures.includes('shell-reader-dark.png'))
  assert(result.captures.includes('surface-reader-dark.png'))
  assert(result.captures.includes('shell-marker-action-light.png'))
  assert(result.captures.includes('shell-marker-action-dark.png'))
  assert(result.captures.includes('surface-marker-action-light.png'))
  assert(result.captures.includes('surface-marker-action-dark.png'))
  assert(
    result.checks.includes(
      'native-keyboard-enable-disable-reorder-persists-through-production-capabilities',
    ),
  )
  assert(
    result.checks.includes('delayed-native-a-b-a-marker-result-does-not-resurrect-old-annotation'),
  )
  assert(
    result.checks.includes(
      'native-reader-header-retry-recovers-action-reconciliation-in-both-surfaces',
    ),
  )
  assert(result.checks.includes('native-reader-retains-unstar-state-after-refused-gmail-unstar'))
  assert(
    result.checks.includes('native-shell-click-during-secondary-refetch-advances-marker-sequence'),
  )
  for (const capture of result.captures) assert((await stat(join(evidence, capture))).size > 0)
  const frames = await readdir(join(evidence, 'frames'))
  assert(frames.length > 0, 'native frame capture must produce recording frames')
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-framerate',
      '5',
      '-i',
      join(evidence, 'frames/frame-%04d.png'),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      join(evidence, 'native-complete.mp4'),
    ],
    { stdio: 'ignore' },
  )
  const keyframes = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'frame=key_frame',
      '-of',
      'csv=p=0',
      join(evidence, 'native-complete.mp4'),
    ],
    { encoding: 'utf8' },
  )
  assert(
    keyframes.split(/\r?\n/).some((frame) => frame.trim().startsWith('1')),
    'recorded video must contain an inspected key frame',
  )
  assert(
    result.checks.includes(
      'native-stale-annotation-does-not-prevent-first-star-in-both-mail-lists',
    ),
  )
  assert(
    result.checks.includes('native-refused-unstar-error-retries-reconciliation-without-replay'),
  )
  assert(result.checks.includes('native-shell-list-retry-recovers-refused-unstar-without-replay'))
  assert(result.checks.includes('both-production-mail-lists-star-without-opening-or-marking-read'))
  assert(
    result.checks.includes('native-four-click-production-cycle-wraps-through-configured-markers'),
  )
  assert(
    result.checks.includes('native-single-marker-star-then-delayed-unstar-in-both-mail-surfaces'),
  )
  assert(result.checks.includes('mounted-mail-surfaces-observe-preference-reorder-without-remount'))
  assert(result.checks.includes('production-account-local-marker-store-and-restart-persistence'))
  assert(result.checks.includes('native-account-context-switch-and-marker-store-isolation'))
  assert(result.checks.includes('native-electron-production-connections-section-mounted'))
  assert.deepEqual(result.networkDenied, [], 'unexpected outbound requests were attempted')
  assert.deepEqual(result.rendererErrors, [], 'renderer emitted errors or unhandled rejections')
  assert.deepEqual(result.mountedSections, [
    'Production connections settings',
    'Production app-shell mail',
    'Production legacy mail reader',
  ])
  assert.match(result.rendererText, /Personal markers/)
  assert.match(result.rendererText, /Yellow star/)
  assert.match(result.rendererText, /Red star/)
  assert.match(result.rendererText, /Blue question mark/)
  for (const marker of ['Yellow star', 'Red star', 'Blue question mark']) {
    assert.equal(
      result.rendererSymbols.filter((label) => label === marker).length,
      2,
      `${marker} must appear in both mail lists`,
    )
  }
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
