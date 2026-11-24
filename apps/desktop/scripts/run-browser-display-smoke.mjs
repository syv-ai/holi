import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { constants, rmSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { externalizeDepsPlugin } from 'electron-vite'

function killElectronTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    } else {
      process.kill(-child.pid, signal)
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(
  process.argv.slice(2).find((argument) => argument !== '--') ??
    join(tmpdir(), `holi-553-evidence-${Date.now()}-${process.pid}`),
)
const fixture = join(desktop, 'scripts/browser-display-fixture')
const appHintsOnly = process.env.HOLI_509_APP_HINTS_ONLY === '1'
const appHintVideo = appHintsOnly && process.env.HOLI_509_RECORD_VIDEO === '1'
const hintsAcceptance = process.env.HOLI_524_HINTS === '1'
const toolbarAcceptance = !appHintsOnly && (process.env.HOLI_553_UI === '1' || hintsAcceptance)
const recordingPath = join(evidence, 'interaction.mp4')
const root = await mkdtemp(join(tmpdir(), 'holi-523-smoke-'))
process.once('exit', () => rmSync(root, { recursive: true, force: true }))
const ownedAppName = `HoliSmoke-app-hints-${process.pid}-${randomUUID()}.app`
const ownedApp = join(root, ownedAppName)
let child
let closed
let log = ''
try {
  await mkdir(evidence, { recursive: true })
  if (appHintVideo) {
    for (const executable of ['ffmpeg', 'ffprobe'])
      execFileSync(executable, ['-version'], { timeout: 10_000, stdio: 'pipe' })
  }
  const fixtureRoot = join(root, 'app-frame-renderer')
  await mkdir(fixtureRoot, { recursive: true })
  const reactPlugin = react()
  await build({
    configFile: false,
    root: desktop,
    base: './',
    resolve: {
      alias: [
        {
          find: '@/plugin-api',
          replacement: join(desktop, 'scripts/app-frame-renderer-fixture-api.ts'),
        },
        { find: '@', replacement: join(desktop, 'src/renderer/src') },
        { find: 'react-dom', replacement: join(desktop, 'node_modules/react-dom') },
        { find: 'react', replacement: join(desktop, 'node_modules/react') },
      ],
      dedupe: ['react', 'react-dom', 'jotai'],
    },
    plugins: [reactPlugin, tailwindcss()],
    define: { process: JSON.stringify({ env: { NODE_ENV: 'development' } }) },
    build: {
      outDir: join(fixtureRoot, 'dist'),
      emptyOutDir: true,
      lib: {
        entry: join(desktop, 'scripts/app-frame-renderer-fixture.tsx'),
        name: 'HoliAppFrameFixture',
        formats: ['iife'],
        fileName: () => 'fixture.js',
        cssFileName: 'fixture',
      },
    },
  })
  await writeFile(
    join(fixtureRoot, 'index.html'),
    '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="dist/fixture.css"></head><body><div id="root"></div><script src="dist/fixture.js"></script></body></html>',
  )
  await build({
    configFile: false,
    root: desktop,
    build: {
      ssr: true,
      target: 'node24',
      outDir: root,
      emptyOutDir: false,
      rollupOptions: {
        input: join(desktop, 'src/preload/index.ts'),
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'production-preload.cjs' },
      },
    },
  })
  await rm(join(evidence, 'frames'), { recursive: true, force: true })
  await rm(join(evidence, 'hints-frames'), { recursive: true, force: true })
  for (const name of [
    'result.json',
    'electron-smoke.log',
    'browser-before.png',
    'shell-before.png',
    'browser-after.png',
    'vault-app-a.png',
    'vault-app-b.png',
    'app-frame-read-a.png',
    'app-frame-read-b.png',
    'app-hints-light.png',
    'app-hints-dark.png',
    'browser-dark.png',
    'recording.json',
    'rich-affinity.json',
    'multiline-native-interactions.json',
    'ui-light.png',
    'ui-dark.png',
    'interaction.mp4',
    'app-hints-interaction.mp4',
    'app-hints-recording.json',
    'hints-result.json',
    'hints-page-light.png',
    'hints-page-dark.png',
    'hints-shell-light.png',
    'hints-shell-dark.png',
    'hints-interaction.mp4',
  ])
    await rm(join(evidence, name), { force: true })
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
  const toolbarSequence = readFileSync(join(fixture, 'toolbar-sequence.ts'), 'utf8')
  const hintsSequence = readFileSync(join(fixture, 'hints-sequence.ts'), 'utf8')
  const sequence = hintsAcceptance
    ? toolbarSequence.replace(
        "  await pref(true)\n  await badge('insert')\n",
        `  await pref(true)\n  await badge('insert')\n${hintsSequence}\n`,
      )
    : toolbarSequence
  if (hintsAcceptance)
    assert.notEqual(sequence, toolbarSequence, 'hints must run before toolbar actions')
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
            'webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: process.env.HOLI_553_PRELOAD }',
          )
          const forwarding = mutableWindow.replace(
            'sent.push(event)\n      },',
            "sent.push(event)\n        if (!win.webContents.isDestroyed()) win.webContents.send('qa:event', event)\n      },",
          )
          return forwarding.replace(
            '  assert.equal(listeners.size, 0)',
            `${toolbarAcceptance || hintsAcceptance ? sequence : ''}\n  assert.equal(listeners.size, 0)`,
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
  let launchBinary = electron
  if (process.platform === 'darwin') {
    const electronBundle = resolve(dirname(electron), '..', '..')
    await cp(electronBundle, ownedApp, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    }).catch(async (cloneError) => {
      await rm(ownedApp, { recursive: true, force: true })
      try {
        await cp(electronBundle, ownedApp, { recursive: true, verbatimSymlinks: true })
      } catch (copyError) {
        throw new AggregateError(
          [cloneError, copyError],
          'Could not create the owned Electron app copy',
        )
      }
    })
    const infoPlist = join(ownedApp, 'Contents', 'Info.plist')
    const bundleIdentifier = `com.holi.smoke.app-hints.${process.pid}.${randomUUID()}`
    execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', `Set :CFBundleIdentifier ${bundleIdentifier}`, infoPlist],
      { timeout: 10_000 },
    )
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', ownedApp], {
      timeout: 30_000,
    })
    launchBinary = join(ownedApp, 'Contents', 'MacOS', 'Electron')
  }
  const env = {
    ...process.env,
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
    HOLI_473_ROOT: root,
    HOLI_473_EVIDENCE: evidence,
    HOLI_473_RENDERER: join(fixtureRoot, 'index.html'),
    HOLI_473_PRELOAD: join(root, 'production-preload.cjs'),
    HOLI_472_ROOT: root,
    HOLI_472_EVIDENCE: evidence,
    HOLI_553_RENDERER: join(root, 'renderer'),
    HOLI_553_PRELOAD: join(fixture, 'preload.cjs'),
    HOLI_553_SHA: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim(),
    HOLI_553_WORKTREE: execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim(),
    HOLI_553_STATUS: execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim(),
    HOLI_509_SOURCE_HASH: createHash('sha256')
      .update(
        [
          'scripts/app-hint-interactions.ts',
          'scripts/app-hint-recorder.ts',
          'scripts/app-frame-smoke.ts',
          'scripts/run-browser-display-smoke.mjs',
          'scripts/app-frame-renderer-fixture.tsx',
          'scripts/app-frame-renderer-fixture.css',
          'scripts/app-frame-renderer-fixture-api.ts',
          'src/plugins/apps/renderer/app-frame.tsx',
          'src/renderer/src/features/shell/host-hint-layer.tsx',
          'src/renderer/src/lib/host-hints.ts',
        ]
          .map((path) => `${path}\0${readFileSync(join(desktop, path))}`)
          .join('\0'),
      )
      .digest('hex'),
    HOLI_553_SOURCE_HASH: createHash('sha256')
      .update(
        [
          'apps/desktop/src/plugins/browser/main/page-script.js',
          'apps/desktop/src/plugins/browser/main/pages.ts',
          'apps/desktop/src/plugins/browser/main/capabilities.ts',
          'apps/desktop/src/plugins/browser/renderer/browser-hints.ts',
          'apps/desktop/src/renderer/src/features/shell/host-hint-layer.tsx',
          'apps/desktop/src/renderer/src/lib/host-hints.ts',
          'packages/shared/src/hint-presentation.ts',
          'apps/desktop/scripts/browser-display-fixture/entry.tsx',
          'apps/desktop/scripts/browser-display-smoke.ts',
          'apps/desktop/scripts/browser-display-fixture/toolbar-sequence.ts',
          'apps/desktop/scripts/browser-display-fixture/hints-sequence.ts',
          'apps/desktop/scripts/run-browser-display-smoke.mjs',
        ]
          .map((path) => `${path}\0${readFileSync(join(desktop, '..', '..', path))}`)
          .join('\0'),
      )
      .digest('hex'),
  }
  delete env.ELECTRON_RUN_AS_NODE
  const launch = spawn(launchBinary, [root], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
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
          killElectronTree(child)
          reject(new Error('Electron smoke timed out'))
        }, 150_000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
  assert.equal(code, 0, 'native Electron browser display smoke failed')
  const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'))
  assert.equal(result.ok, true)
  for (const check of [
    ...(appHintsOnly
      ? []
      : [
          'production-host-and-browser-activations',
          'electron43-webrequest-native-window-and-frame-provenance',
          'queued-native-action-expires-on-tab-hide',
          'queued-action-expires-across-return',
          'hidden-native-input-and-placement-are-inert',
          'hidden-popup-keeps-data-without-presentation',
          'stopping-a-preserves-b-native-view-and-capabilities',
          'departure-detaches-synchronously',
          'displayed-page-attached-with-loaded-content',
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
                'plaintext-host-rearms-after-overlay',
                'production-visible-hide-return-rearms-field',
                'plaintext-host-rearms-after-hide-return',
                'native-shell-zoom-keeps-mode-and-field-input',
                'native-reload-rejects-old-document-arm-and-reconfigures',
                'plaintext-host-rearms-after-reload',
                'native-navigation-reinitializes-current-document',
                'plaintext-host-rearms-after-navigation',
                'native-A-B-A-identical-tab-ids-retain-own-vim-context',
                'native-same-id-replacement-gets-fresh-vim-owner',
                'native-composition-preserves-unmodified-insert-path',
                'production-toolbar-native-interaction-light-dark-and-trusted-recording',
                'native-rich-contenteditable-recorded',
                'production-multiline-paragraph-div-br-inline-contenteditable-edit-history',
                'native-baseline-and-vim-rich-link-start-affinity-undo-redo',
                'plaintext-host-replacement-releases-old-owner',
              ]
            : []),
          'native-h-l-w-b-e-0-caret-dollar-and-i-a',
          'native-shift-selection-preserved-in-vim-normal-mode',
          'native-same-document-navigation-rearms-insert-mode',
          'native-aborted-navigation-recovers-surviving-document-configuration',
          'native-grapheme-safe-horizontal-motion',
          'native-j-k-vertical-column',
          'unsupported-password-number-readonly-contenteditable-shadow-frame-passthrough',
          'native-plaintext-only-motion-insert-and-native-undo-redo',
          'native-plaintext-selection-i-keeps-insert-before-selection-behavior',
          'native-rich-inline-motion-insert-undo-redo-preserves-formatting-and-link',
          'rich-css-loss-and-restoration-retains-native-key-ownership',
          'rich-href-loss-and-restoration-retains-native-key-ownership',
          'rich-inert-transition-releases-native-key-ownership',
          'native-rich-inline-ime-composition-retains-formatting-and-link',
          'native-plaintext-ime-composition-remains-native',
          'plaintext-live-preference-off-passes-native-typing',
          'plaintext-shape-loss-and-restoration-invalidates-normal-ownership',
          'plaintext-outside-selection-escape-passthrough-and-reset',
          'native-empty-host-and-contenteditable-disable-passthrough',
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
        ]),
    'leased-real-app-frame-owner-a-resources',
    'production-injected-app-hints-filter-and-activate-a',
    'production-injected-app-hints-filter-and-activate-b',
    'production-command-runner-waits-for-command-script-a',
    'production-command-runner-waits-for-command-script-b',
    'actual-vault-app-screenshot-a',
    'native-svg-replacement-revokes-before-subsequent-capability-use-a',
    'revoked-app-lease-denied-a',
    'leased-real-app-frame-owner-b-resources',
    'actual-vault-app-screenshot-b',
    'production-app-frame-hostbridge-trpc-preload-and-main-app-door-read-a',
    'production-app-frame-native-f-hint-label-keys-activate-repeatedly-through-host-layer',
    'production-app-frame-open-closed-and-nested-shadow-editors-preserve-native-f',
    'production-app-frame-vim-off-preserves-native-guest-input-typing',
    'production-app-frame-mutation-overlay-hidden-show-reload-focus-cycle-discards-stale-hints',
    'production-app-frame-vim-disable-removes-native-hint-labels',
    'production-app-frame-wrong-source-message-has-no-capability-side-effect',
    'production-app-frame-old-nonce-after-replacement-has-no-side-effect-or-reply',
    'production-app-frame-hostbridge-trpc-preload-and-main-app-door-read-b',
    'production-app-frame-hidden-after-real-capture-rejects-stale-preview',
    'production-app-frame-fresh-visible-capture-saved-native-preview',
    'production-app-frame-overlay-without-layout-event-rejects-stale-capture-and-recovers',
    'production-app-frame-a-to-b-to-a-invalidates-delayed-real-capture',
    'production-app-frame-navigation-replacement-cannot-reach-hostbridge',
    'native-child-dom-removal-revokes-lease-and-suppresses-queued-bridge-reply',
    'root-renderer-reload-revokes-old-lease-and-fresh-frame-reads-own-note',
    'native-svg-replacement-revokes-before-subsequent-capability-use-b',
    'revoked-app-lease-denied-b',
    'production-command-runner-result-a',
    'production-command-runner-result-b',
    'legacy-unleased-app-url-denied-a',
    'legacy-unleased-app-url-denied-b',
    'foreign-window-app-request-denied-a',
    'foreign-window-app-request-denied-b',
  ])
    assert(result.checks.includes(check), `missing native check: ${check}`)
  assert(
    result.checks.length >= (toolbarAcceptance ? 47 : 30),
    'native smoke produced too few assertions',
  )
  if (appHintsOnly) assert.equal(result.checks.length, 34, 'app hint smoke must pass all 34 checks')
  if (hintsAcceptance) {
    const browserHintChecks = [
      'native-page-f-discovers-production-page-and-host-labels',
      'native-checkbox-and-aria-switch-discovery-with-trusted-activation',
      'body-button-link-focus-request-hints-with-trusted-activation',
      'waapi-target-movement-revokes-page-and-host-labels',
      'native-escape-retires-delayed-action-and-routes-exact-host-cancellation',
      'native-host-escape-cancels-selected-delayed-browser-action',
      'transparent-targets-and-ancestors-excluded-and-opacity-mutation-revokes',
      'native-prediscovery-escape-cancels-request-without-host-fallback',
      'installed-kbd-light-dark-and-custom-theme-presentation-matches-page',
      'native-prediscovery-overflow-releases-escape-input-and-fresh-capture',
      'page-label-activation-produces-trusted-native-button-click',
      'supported-field-handoff-enters-insert-and-receives-native-typing',
      'native-prefix-backspace-and-escape-clear-request-scoped-labels',
      'overlay-change-invalidates-page-and-host-labels',
      'hide-return-invalidates-old-page-and-host-labels',
      'page-dom-mutation-invalidates-visible-labels-and-actions',
      'native-page-scroll-invalidates-page-and-host-labels',
      'shell-zoom-invalidates-page-and-host-labels',
      'preference-off-insert-and-modified-keys-pass-through',
      'page-label-activation-produces-trusted-native-link-click',
      'native-page-light-dark-and-shell-evidence-captured',
      'hint-owned-navigation-replacement-rearms-current-document',
    ]
    for (const check of browserHintChecks)
      assert(result.checks.includes(check), `missing browser hint check: ${check}`)
    const hints = JSON.parse(await readFile(join(evidence, 'hints-result.json'), 'utf8'))
    assert.equal(hints.ok, true)
    assert.equal(hints.source, env.HOLI_553_SHA)
    assert.equal(hints.sourceHash, env.HOLI_553_SOURCE_HASH)
    assert.deepEqual(hints.runtimeErrors, [])
    const hintVideo = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-framerate',
        '8',
        '-i',
        join(evidence, 'hints-frames/%05d.png'),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        join(evidence, 'hints-interaction.mp4'),
      ],
      { encoding: 'utf8', timeout: 60_000 },
    )
    assert.equal(hintVideo.status, 0, `hints video encoding failed: ${hintVideo.stderr}`)
    assert((await stat(join(evidence, 'hints-interaction.mp4'))).size > 0)
    for (const name of hints.evidence)
      assert((await stat(join(evidence, name))).size > 0, `missing hints evidence: ${name}`)
  }
  let recording
  if (toolbarAcceptance) {
    recording = JSON.parse(await readFile(join(evidence, 'recording.json'), 'utf8'))
    assert(
      recording.frames > 0 &&
        recording.finalValue === 'one native two three!' &&
        recording.trusted.length > 10 &&
        recording.trusted.every((event) => event.trusted),
      'recording lacks trusted native input',
    )
    assert.equal(recording.source, env.HOLI_553_SHA, 'recording source HEAD mismatch')
    assert.equal(recording.sourceHash, env.HOLI_553_SOURCE_HASH, 'recording source hash mismatch')
    assert.equal(recording.worktree, env.HOLI_553_WORKTREE, 'recording worktree mismatch')
    assert.equal(
      recording.worktreeStatus,
      env.HOLI_553_STATUS,
      'recording worktree status mismatch',
    )
    const affinity = JSON.parse(await readFile(join(evidence, 'rich-affinity.json'), 'utf8'))
    assert.equal(affinity.baselineMode, 'disabled')
    assert.deepEqual(affinity.vimMarkup, affinity.markup)
    assert.deepEqual(affinity.vimAfterSelection, affinity.afterSelection)
    assert.deepEqual(affinity.beforeSelection, {
      node: '#text',
      parent: 'A',
      offset: 0,
      text: 'café🙂 link',
      collapsed: true,
    })
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
    [
      ...(appHintsOnly
        ? []
        : ['browser-before.png', 'browser-dark.png', 'shell-before.png', 'browser-after.png']),
      'vault-app-a.png',
      'vault-app-b.png',
      'app-frame-read-a.png',
      'app-frame-read-b.png',
      'app-hints-light.png',
      'app-hints-dark.png',
    ],
    'native smoke screenshot list is incomplete',
  )
  for (const name of result.screenshots) {
    assert((await stat(join(evidence, name))).size > 0, `missing screenshot: ${name}`)
  }
  if (appHintVideo) {
    const metadataPath = join(evidence, 'app-hints-recording.json')
    const recording = JSON.parse(await readFile(metadataPath, 'utf8'))
    assert.equal(recording.interactionCompleted, true)
    assert.deepEqual(recording.finalOutcomes, {
      actionCount: '2',
      inputValue: 'native',
      vimEnabled: false,
      hintsVisible: false,
    })
    assert.equal(recording.source, env.HOLI_553_SHA)
    assert.equal(recording.sourceHash, env.HOLI_509_SOURCE_HASH)
    assert.equal(recording.worktree, env.HOLI_553_WORKTREE)
    assert.equal(recording.worktreeStatus, env.HOLI_553_STATUS)
    assert(recording.frames >= 80 && recording.frames <= 900, 'implausible owned frame count')
    assert(recording.elapsedMs >= 10_000 && recording.elapsedMs <= 90_000)
    const videoPath = join(evidence, 'app-hints-interaction.mp4')
    const video = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '1',
        '-i',
        join(root, 'app-hint-frames/frames.ffconcat'),
        '-fps_mode',
        'vfr',
        '-c:v',
        'libx264',
        '-crf',
        '25',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        videoPath,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    )
    assert.equal(video.status, 0, `owned video encoding failed: ${video.error ?? video.stderr}`)
    const size = (await stat(videoPath)).size
    assert(size > 0 && size <= 10 * 1024 * 1024, 'owned video must fit the 10 MB attachment limit')
    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-count_frames',
          '-show_entries',
          'stream=width,height,nb_read_frames,duration:format=duration',
          '-of',
          'json',
          videoPath,
        ],
        { encoding: 'utf8', timeout: 10_000 },
      ),
    )
    const stream = probe.streams[0]
    assert(stream && Number(stream.nb_read_frames) >= recording.frames)
    assert(Number(stream.nb_read_frames) <= recording.frames + 1)
    assert(Math.abs(Number(probe.format.duration) * 1000 - recording.elapsedMs) < 250)
    assert.equal(stream.width, recording.dimensions.width)
    assert.equal(stream.height, recording.dimensions.height)
    await writeFile(
      metadataPath,
      JSON.stringify(
        {
          ...recording,
          checks: result.checks,
          screenshots: result.screenshots,
          electron: result.electron,
          video: { filename: 'app-hints-interaction.mp4', bytes: size, ...probe },
        },
        null,
        2,
      ),
    )
    console.log(`PASS owned app hint video: ${recording.frames} frames, ${size} bytes`)
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
      { encoding: 'utf8', timeout: 60_000 },
    )
    assert.equal(video.status, 0, `video encoding failed: ${video.stderr}`)
    assert((await stat(recordingPath)).size > 0, 'video artifact is empty')
  }
} finally {
  if (child && child.exitCode === null) {
    killElectronTree(child, 'SIGTERM')
    const exited = await Promise.race([
      closed.then(
        () => true,
        () => true,
      ),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ])
    if (!exited) {
      killElectronTree(child, 'SIGKILL')
      await closed.catch(() => {})
    }
  }
  try {
    await writeFile(join(evidence, 'electron-smoke.log'), log)
  } finally {
    await rm(root, { recursive: true, force: true })
    await writeFile(
      join(evidence, 'cleanup.json'),
      JSON.stringify(
        {
          runtimeRemoved: true,
          ownedAppRemoved: true,
          root,
          ownedApp,
          launcherPid: child?.pid ?? null,
        },
        null,
        2,
      ),
    )
  }
}
