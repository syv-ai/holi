import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { externalizeDepsPlugin } from 'electron-vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? join(tmpdir(), 'holi-473-app-evidence'))
const root = await mkdtemp(join(tmpdir(), 'holi-473-smoke-'))
await mkdir(evidence, { recursive: true })
for (const name of [
  'result.json',
  'electron-smoke.log',
  'browser-before.png',
  'shell-before.png',
  'browser-after.png',
  'vault-app-a.png',
  'vault-app-b.png',
])
  await rm(join(evidence, name), { force: true })
let child
let closed
let log = ''
try {
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
        input: join(desktop, 'scripts/browser-display-smoke.ts'),
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
    JSON.stringify({ name: 'holi-browser-display-qa-472', main: 'main.cjs' }),
  )
  const electron = createRequire(import.meta.url)('electron')
  const env = {
    ...process.env,
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
    HOLI_473_ROOT: root,
    HOLI_473_EVIDENCE: evidence,
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
  const { readFile, stat } = await import('node:fs/promises')
  const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'))
  assert.equal(result.ok, true)
  for (const check of [
    'production-host-and-browser-activations',
    'electron43-webrequest-native-window-and-frame-provenance',
    'queued-native-action-expires-on-tab-hide',
    'queued-action-expires-across-return',
    'hidden-native-input-and-placement-are-inert',
    'hidden-popup-keeps-data-without-presentation',
    'stopping-a-preserves-b-native-view-and-capabilities',
    'departure-detaches-synchronously',
    'displayed-page-attached-with-loaded-content',
    'hidden-authorized-page-read-type-and-press-work',
    'duplicate-page-ids-have-distinct-native-views',
    'return-requires-fresh-owner-placement',
    'same-id-reincarnation-rejects-stale-placement',
    'departure-to-null-removes-replacement',
    'pending-reconcile-stop-detaches-to-b',
    'pending-reconcile-stop-detaches-to-null',
    'pending-reconcile-stop-all-detaches-to-b',
    'pending-reconcile-stop-all-detaches-to-null',
    'leased-real-app-frame-owner-a-resources',
    'actual-vault-app-screenshot-a',
    'native-svg-replacement-revokes-before-subsequent-capability-use-a',
    'revoked-app-lease-denied-a',
    'leased-real-app-frame-owner-b-resources',
    'actual-vault-app-screenshot-b',
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
  assert(result.checks.length >= 18, 'native smoke produced too few assertions')
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
      'browser-before.png',
      'shell-before.png',
      'browser-after.png',
      'vault-app-a.png',
      'vault-app-b.png',
    ],
    'native smoke screenshot list is incomplete',
  )
  for (const name of result.screenshots)
    assert((await stat(join(evidence, name))).size > 0, `missing screenshot: ${name}`)
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
  }
}
