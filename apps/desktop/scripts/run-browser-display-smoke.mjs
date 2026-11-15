import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'
import { readFileSync } from 'node:fs'
import { externalizeDepsPlugin } from 'electron-vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? '/tmp/holi-523-ui-evidence')
const fixture = join(desktop, 'scripts/browser-display-fixture')
const toolbarAcceptance = process.env.HOLI_523_UI === '1'
const recordingPath = join(evidence, 'interaction.mp4')
const root = await mkdtemp(join(tmpdir(), 'holi-523-smoke-'))
await mkdir(evidence, { recursive: true })
for (const name of [
  'result.json',
  'electron-smoke.log',
  'browser-before.png',
  'shell-before.png',
  'browser-after.png',
  'browser-dark.png',
  'recording.json',
  'ui-light.png',
  'ui-dark.png',
  'interaction.mp4',
])
  await rm(join(evidence, name), { force: true })
let child
let closed
let log = ''
try {
  await build({
    configFile: false,
    base: './',
    root: fixture,
    resolve: {
      alias: { '@': join(desktop, 'src/renderer/src') },
      dedupe: ['react', 'react-dom', 'jotai'],
    },
    esbuild: { jsx: 'automatic' },
    plugins: [
      (
        await import(
          pathToFileURL(createRequire(join(desktop, 'package.json')).resolve('@tailwindcss/vite'))
        )
      ).default(),
    ],
    build: { outDir: join(root, 'renderer'), emptyOutDir: true, minify: false },
  })
  const source = join(desktop, 'scripts/browser-display-smoke.ts')
  const sequence = readFileSync(join(fixture, 'toolbar-sequence.ts'), 'utf8')
  await build({
    configFile: false,
    root: desktop,
    plugins: [
      externalizeDepsPlugin({ exclude: ['@holi/shared'] }),
      {
        name: 'browser-display-toolbar-acceptance',
        enforce: 'pre',
        transform(code, id) {
          if (id !== source) return null
          const imports = code.replace(
            "import { app, BrowserWindow, session, type WebContentsView } from 'electron'",
            "import { app, BrowserWindow, session, ipcMain, nativeImage, type WebContentsView } from 'electron'",
          )
          const mutableWindow = imports.replace(
            'webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }',
            'webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: process.env.HOLI_523_PRELOAD }',
          )
          const forwarding = mutableWindow.replace(
            'sent.push(event)\n      },',
            "sent.push(event)\n        if (!win.webContents.isDestroyed()) win.webContents.send('qa:event', event)\n      },",
          )
          return forwarding.replace(
            '  assert.equal(listeners.size, 0)',
            `${toolbarAcceptance ? sequence : ''}\n  assert.equal(listeners.size, 0)`,
          )
        },
      },
    ],
    build: {
      ssr: true,
      target: 'node24',
      outDir: root,
      emptyOutDir: false,
      rollupOptions: {
        input: source,
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
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-browser-display-qa-523', main: 'main.cjs' }),
  )
  const electron = createRequire(import.meta.url)('electron')
  const env = {
    ...process.env,
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
    HOLI_472_ROOT: root,
    HOLI_472_EVIDENCE: evidence,
    HOLI_523_RENDERER: join(root, 'renderer'),
    HOLI_523_PRELOAD: join(fixture, 'preload.cjs'),
    HOLI_523_SHA: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  }
  delete env.ELECTRON_RUN_AS_NODE
  const launch = spawn(electron, [root], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child = launch
  child.stdout.on('data', (chunk) => {
    log += chunk
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    log += chunk
    process.stderr.write(chunk)
  })
  let timeout
  let code
  closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  try {
    code = await Promise.race([
      closed,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          child.kill()
          reject(new Error('Electron smoke timed out'))
        }, 60_000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
  assert.equal(code, 0, 'native Electron browser display smoke failed')
  const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'))
  assert.equal(result.ok, true)
  for (const check of [
    ...(toolbarAcceptance
      ? [
          'production-host-and-browser-activations',
          'queued-native-action-expires-on-tab-hide',
          'queued-action-expires-across-return',
          'hidden-native-input-and-placement-are-inert',
          'hidden-popup-keeps-data-without-presentation',
          'stopping-a-preserves-b-native-view-and-capabilities',
          'departure-detaches-synchronously',
          'displayed-page-attached-with-loaded-content',
          'native-browser-vim-mode-navigation-insertion-undo-redo',
          'production-browser-surface-I-A-native-insertion-and-actual-mode',
          'native-same-vault-two-pane-tabs-own-input-and-mode-independently',
          'production-preference-disables-and-reenables-native-page',
          'production-overlay-restores-vim-with-fresh-attachment',
          'production-visible-hide-return-rearms-field',
          'native-shell-zoom-keeps-mode-and-field-input',
          'native-reload-rejects-old-document-arm-and-reconfigures',
          'native-navigation-reinitializes-current-document',
          'native-A-B-A-identical-tab-ids-retain-own-vim-context',
          'native-same-id-replacement-gets-fresh-vim-owner',
          'native-composition-preserves-unmodified-insert-path',
          'production-toolbar-native-interaction-light-dark-and-trusted-recording',
        ]
      : []),
    'native-h-l-w-b-e-0-caret-dollar-and-i-a',
    'native-grapheme-safe-horizontal-motion',
    'native-j-k-vertical-column',
    'unsupported-password-number-readonly-contenteditable-shadow-frame-passthrough',
    'native-ime-composition-in-insert-mode',
    'preference-disable-reenable-controls-native-vim',
    'native-normal-escape-preserves-search-value',
    'native-leading-newline-line-start',
    'stale-vim-disable-request-rejected',
    'vim-rearms-after-native-reattachment',
    'hidden-authorized-page-read-type-and-press-work',
    'duplicate-page-ids-have-distinct-native-views',
    'return-requires-fresh-owner-placement',
    'same-id-reincarnation-rejects-stale-placement',
    'departure-to-null-removes-replacement',
    'pending-reconcile-stop-detaches-to-b',
    'pending-reconcile-stop-detaches-to-null',
    'pending-reconcile-stop-all-detaches-to-b',
    'pending-reconcile-stop-all-detaches-to-null',
  ])
    assert(result.checks.includes(check), `missing native check: ${check}`)
  assert(
    result.checks.length >= (toolbarAcceptance ? 39 : 28),
    'native smoke produced too few assertions',
  )
  let recording
  if (toolbarAcceptance) {
    recording = JSON.parse(await readFile(join(evidence, 'recording.json'), 'utf8'))
    assert(
      recording.frames > 0 &&
        recording.trusted.length > 10 &&
        recording.trusted.every((event) => event.trusted),
      'recording lacks trusted native input',
    )
    assert.equal(recording.source, env.HOLI_523_SHA, 'recording source HEAD mismatch')
  }
  assert(
    typeof result.electron === 'string' && result.electron.length > 0,
    'missing Electron version',
  )
  assert(
    result.roots && result.roots.profile && result.roots.vaultA && result.roots.vaultB,
    'missing isolated roots',
  )
  assert.deepEqual(
    result.screenshots,
    ['browser-before.png', 'browser-dark.png', 'shell-before.png', 'browser-after.png'],
    'native smoke screenshot list is incomplete',
  )
  for (const name of result.screenshots) {
    assert((await stat(join(evidence, name))).size > 0, `missing screenshot: ${name}`)
  }
  if (toolbarAcceptance) {
    for (const name of ['ui-light.png', 'ui-dark.png'])
      assert((await stat(join(evidence, name))).size > 0, `missing screenshot: ${name}`)
    assert(
      (await stat(join(evidence, 'recording.json'))).size > 0,
      'missing native input recording',
    )
    const fps = recording.frames / (recording.elapsedMs / 1000)
    const video = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-framerate',
        String(fps),
        '-i',
        join(evidence, 'frames/%05d.png'),
        '-frames:v',
        String(recording.frames),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        recordingPath,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(video.status, 0, `video encoding failed: ${video.stderr}`)
    assert((await stat(recordingPath)).size > 0, 'video artifact is empty')
  }
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    const exited = await Promise.race([
      closed.then(
        () => true,
        () => true,
      ),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
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
    await writeFile(
      join(evidence, 'cleanup.json'),
      JSON.stringify({ runtimeRemoved: true, root, launcherPid: child?.pid ?? null }, null, 2),
    )
  }
}
