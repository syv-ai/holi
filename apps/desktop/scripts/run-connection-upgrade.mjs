#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, realpath, rm, statfs, writeFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'vite'
import { externalizeDepsPlugin } from 'electron-vite'
import { createOwnedProcesses } from './owned-processes.mjs'
import { createUpgradeProviders } from './connection-upgrade-provider.mjs'
import { connectUpgradeInspector } from './upgrade-inspector.mjs'
import { createUpgradeInstaller, installerStatePath } from './upgrade-installer.mjs'

const exec = promisify(execFile)
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const oldTag = 'v0.8.1-dev.275'
const newTag = 'v0.8.1-dev.276'
const team = '2DD8ZKZ975'
const owned = createOwnedProcesses()
const abort = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => abort.abort())
const receipt = { issue: 565, phase: 'preflight', upgrade: false, restored: false }
let evidence
let root
let inspector
let profile
let vaultRoot
let ownsProfile = false
let artifact
let installer
let installerGuardReady = false
let providers
let feed
const launchKeys = []

async function command(bin, args, options = {}) {
  const { cleanup = false, ...rest } = options
  return exec(bin, args, {
    timeout: 30_000,
    maxBuffer: 2_000_000,
    signal: cleanup ? undefined : abort.signal,
    ...rest,
  })
}
async function absent(path) {
  try {
    await lstat(path)
    return false
  } catch (error) {
    if (error.code === 'ENOENT') return true
    throw error
  }
}
async function checkpoint(phase) {
  receipt.phase = phase
  console.log(`connection upgrade: ${phase}`)
  await writeFile(join(evidence, 'result.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })
}
async function wait(label, probe, milliseconds = 120_000, cleanup = false) {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    if (!cleanup) abort.signal.throwIfAborted()
    const value = await probe()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  receipt.timedOut = { phase: label, milliseconds }
  throw new Error(`${label} timed out after ${milliseconds}ms`)
}
async function evaluate(expression) {
  try {
    return await inspector.evaluate(expression)
  } catch (error) {
    if (error.details) receipt.evaluationFailure = error.details
    throw error
  }
}
async function renderer(expression) {
  return evaluate(`(async () => {
    const win = require('electron').BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && !w.webContents.isLoading());
    return win ? await win.webContents.executeJavaScript(${JSON.stringify(expression)}) : null;
  })()`)
}
async function click(text) {
  return renderer(`(() => {
    const node = [...document.querySelectorAll('button,[role="menuitem"],[role="tab"],a')].find(n => n.textContent.trim() === ${JSON.stringify(text)});
    if (!node) return false;
    node.click(); return true;
  })()`)
}
async function accounts(path) {
  try {
    const output = await command(join(profile, 'bin', 'holi'), ['google', 'accounts', '--json'], {
      cwd: path,
      env: { HOME: homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      timeout: 10_000,
    })
    return JSON.parse(output.stdout)
  } catch {
    return null
  }
}
async function ownRuntimePids(mainOnly = false) {
  const result = await command('/bin/ps', ['-axo', 'pid=,command='], { cleanup: true })
  const prefix = mainOnly ? join(artifact, 'Contents', 'MacOS', 'Holi') : `${artifact}/Contents/`
  return result.stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!match) return []
    const program = match[2]
    const owned = mainOnly
      ? program === prefix || program.startsWith(`${prefix} `)
      : program.startsWith(prefix)
    return owned ? [Number(match[1])] : []
  })
}
const ownAppPids = () => ownRuntimePids(true)
async function attach(child) {
  inspector = await connectUpgradeInspector(child, { signal: abort.signal })
  return inspector.frame
}

async function main() {
  assert(process.argv.length === 2, 'no local options or overrides are supported')
  assert(
    process.env.GITHUB_ACTIONS === 'true' &&
      process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
      process.platform === 'darwin' &&
      process.arch === 'arm64' &&
      userInfo().username === 'runner',
    'requires a fresh GitHub-hosted macOS arm64 runner; local execution is forbidden',
  )
  profile = join(homedir(), 'Library', 'Application Support', 'Holi')
  vaultRoot = join(homedir(), 'Holi')
  assert(
    (await absent(profile)) &&
      (await absent(vaultRoot)) &&
      (await absent('/Applications/Holi.app')),
    'refusing existing Holi data or installation',
  )
  const running = await command('/usr/bin/pgrep', ['-x', 'Holi']).catch((error) => {
    if (error.code === 1) return { stdout: '' }
    throw error
  })
  assert(!running.stdout.trim(), 'refusing an existing Holi process')
  const shipit = await command('/usr/bin/pgrep', ['-f', 'ai.syv.holi.ShipIt']).catch((error) => {
    if (error.code === 1) return { stdout: '' }
    throw error
  })
  assert(!shipit.stdout.trim(), 'refusing an existing Holi installer')
  const disk = await statfs(tmpdir())
  assert(disk.bavail * disk.bsize >= 6 * 1024 ** 3, 'insufficient native fixture disk space')
  assert(process.env.RUNNER_TEMP, 'RUNNER_TEMP is required')
  evidence = join(process.env.RUNNER_TEMP, 'holi-565-evidence')
  await mkdir(evidence, { mode: 0o700 })
  root = await realpath(await mkdtemp(join(tmpdir(), 'holi-565-native-')))
  const scratch = join(root, 'installer-guard')
  await mkdir(scratch, { mode: 0o700 })
  const binary = join(scratch, 'upgrade-installer')
  await command('/usr/bin/xcrun', [
    'swiftc',
    join(desktop, 'scripts', 'upgrade-installer.swift'),
    '-o',
    binary,
  ])
  const label = 'ai.syv.holi.ShipIt'
  installer = createUpgradeInstaller({
    binary,
    artifact: join(root, 'installed', 'Holi.app'),
    statePath: installerStatePath(label),
    label,
  })
  await installer.assertAbsent()
  installerGuardReady = true
  await checkpoint('download-signed-artifact')
  const old = JSON.parse(
    (await command('gh', ['release', 'view', oldTag, '--repo', 'syv-ai/holi', '--json', 'assets']))
      .stdout,
  )
  const next = JSON.parse(
    (await command('gh', ['release', 'view', newTag, '--repo', 'syv-ai/holi', '--json', 'assets']))
      .stdout,
  )
  assert(
    old.assets.some((a) => a.name === 'Holi-0.8.1-dev.275-mac-arm64.zip'),
    'old signed ZIP unavailable',
  )
  assert(
    next.assets.some((a) => a.name === 'Holi-0.8.1-dev.276-mac-arm64.zip'),
    'target signed ZIP unavailable',
  )
  await command(
    'gh',
    [
      'release',
      'download',
      oldTag,
      '--repo',
      'syv-ai/holi',
      '--pattern',
      'Holi-0.8.1-dev.275-mac-arm64.zip',
      '--dir',
      root,
    ],
    { timeout: 180_000 },
  )
  await command(
    '/usr/bin/ditto',
    ['-x', '-k', join(root, 'Holi-0.8.1-dev.275-mac-arm64.zip'), join(root, 'installed')],
    { timeout: 120_000 },
  )
  await command(
    'gh',
    [
      'release',
      'download',
      newTag,
      '--repo',
      'syv-ai/holi',
      '--pattern',
      'Holi-0.8.1-dev.276-mac-arm64.zip',
      '--pattern',
      'dev-mac.yml',
      '--dir',
      root,
    ],
    { timeout: 180_000 },
  )
  providers = await createUpgradeProviders(root)
  const feedSockets = new Set()
  feed = createServer((request, response) => {
    const name = new URL(request.url, 'http://127.0.0.1').pathname
    const files = {
      '/dev-mac.yml': 'dev-mac.yml',
      '/Holi-0.8.1-dev.276-mac-arm64.zip': 'Holi-0.8.1-dev.276-mac-arm64.zip',
    }
    if (request.method !== 'GET' || !files[name]) {
      response.writeHead(404)
      response.end()
      return
    }
    createReadStream(join(root, files[name]))
      .on('error', () => response.destroy())
      .pipe(response)
  })
  feed.on('connection', (socket) => {
    feedSockets.add(socket)
    socket.on('close', () => feedSockets.delete(socket))
  })
  feed.stop = async () => {
    for (const socket of feedSockets) socket.destroy()
    await new Promise((resolve) => feed.close(resolve))
  }
  await new Promise((resolve, reject) => {
    feed.once('error', reject)
    feed.listen(0, '127.0.0.1', resolve)
  })
  const feedUrl = `http://127.0.0.1:${feed.address().port}/`
  for (const key of Object.keys(providers.env)) {
    const old = await command('/bin/launchctl', ['getenv', key]).catch((error) => {
      if (error.code === 1) return { stdout: '' }
      throw error
    })
    assert(!old.stdout.trim(), 'refusing pre-existing launch environment settings')
  }
  for (const [key, value] of Object.entries(providers.env)) {
    launchKeys.push(key)
    await command('/bin/launchctl', ['setenv', key, value])
  }
  artifact = join(root, 'installed', 'Holi.app')
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', artifact])
  const signature = await command('/usr/bin/codesign', ['-dv', '--verbose=4', artifact])
  assert(signature.stderr.includes(`TeamIdentifier=${team}`), 'unexpected signing team')
  receipt.artifact = { oldTag, targetTag: newTag, team, signatureVerified: true }
  const bundle = join(root, 'producer')
  await build({
    configFile: false,
    root: desktop,
    plugins: [externalizeDepsPlugin({ exclude: ['@holi/shared'] })],
    build: {
      ssr: true,
      target: 'node24',
      outDir: bundle,
      emptyOutDir: true,
      rollupOptions: {
        input: fileURLToPath(new URL('./upgrade-connection-fixture.ts', import.meta.url)),
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'producer.cjs',
          inlineDynamicImports: true,
          banner: `module.paths.unshift(${JSON.stringify(join(desktop, 'node_modules'))});`,
        },
      },
    },
  })
  // ShipIt deliberately relaunches without our argv/environment. Only this fresh
  // disposable OS account makes its normal default-profile launch safe.
  await mkdir(profile, { recursive: true, mode: 0o700 })
  await mkdir(vaultRoot, { recursive: true, mode: 0o700 })
  ownsProfile = true
  await writeFile(join(profile, 'updates.json'), JSON.stringify({ enabled: true, channel: 'dev' }))
  const child = owned.start(
    join(artifact, 'Contents', 'MacOS', 'Holi'),
    ['--inspect-brk=127.0.0.1:0'],
    {
      cwd: root,
      env: {
        HOME: homedir(),
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        TMPDIR: tmpdir(),
        ...providers.env,
      },
    },
  )
  await attach(child)
  const initial = await evaluate(
    `(() => {
    const { app } = require('electron');
    return { packaged: app.isPackaged, version: app.getVersion(), profile: app.getPath('userData') };
  })()`,
  )
  assert(
    initial.packaged && initial.version === '0.8.1-dev.275' && initial.profile === profile,
    'unexpected packaged app profile/version',
  )
  await evaluate(
    `(() => {
    const { app } = require('electron');
    require('electron-updater').autoUpdater.setFeedURL({ provider: 'generic', url: ${JSON.stringify(feedUrl)} });
    const fs = require('node:fs/promises');
    const original = fs.readFile;
    let release;
    const seeded = new Promise(resolve => { release = resolve; });
    globalThis.__holi565 = { seeded: false };
    fs.readFile = async function(file, ...args) {
      if (String(file) === ${JSON.stringify(join(profile, 'github-auth.enc'))}) await seeded;
      return original.call(this, file, ...args);
    };
    app.once('ready', async () => {
      try {
        globalThis.__holi565.receipt = await require(${JSON.stringify(join(bundle, 'producer.cjs'))}).seedConnections(${JSON.stringify(profile)}, ${JSON.stringify(vaultRoot)});
        globalThis.__holi565.seeded = true;
      } catch (error) { globalThis.__holi565.failed = { type: error.name, code: /^[A-Z_]+$/.test(error.code || '') ? error.code : null }; }
      finally { fs.readFile = original; release(); }
    });
    return true;
  })()`,
  )
  await inspector.resume()
  await checkpoint('actual-authenticated-startup')
  const seeded = await wait('native-credential-seeding', async () => {
    const state = await evaluate('globalThis.__holi565')
    if (state?.failed) receipt.seedFailure = state.failed
    assert(!state?.failed, 'native credential producer failed; details withheld')
    return state?.seeded && state.receipt
  })
  receipt.seeded = true
  const before = await wait('production-google-restoration', async () => {
    const overview = await accounts(seeded.path)
    return overview?.state === 'connected' && overview
  })
  assert(before.client.source === 'own', 'stored OAuth client not selected')
  receipt.before = { googleConnected: true, clientSource: before.client.source }
  await wait('signed-in-window', () =>
    renderer('document.body.innerText.includes("holi-upgrade-fixture")'),
  )
  await evaluate(
    `(() => { const win = require('electron').BrowserWindow.getAllWindows()[0]; win.webContents.sendInputEvent({type:'keyDown', keyCode:',', modifiers:['meta']}); win.webContents.sendInputEvent({type:'keyUp', keyCode:',', modifiers:['meta']}); })()`,
  )
  await wait('connections-navigation', () => click('Connections'))
  await wait('google-connected-ui', () =>
    renderer('document.body.innerText.includes("holi-upgrade-fixture@example.invalid")'),
  )
  receipt.before.googleUiConnected = true
  const image = await evaluate(
    `(async () => (await require('electron').BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))()`,
  )
  await writeFile(join(evidence, 'before-google-connected.png'), Buffer.from(image, 'base64'))
  await wait('updates-navigation', () => click('Updates'))
  await wait(
    'real-update-ready',
    () => renderer('document.body.innerText.includes("Restart to update")'),
    600_000,
  )
  // A normal DOM click invokes the renderer's install atom, tRPC mutation and
  // main's guarded shutdown. No installer/download method is replaced.
  assert(await click('Restart to update'), 'normal install action unavailable')
  inspector.close()
  inspector = null
  await checkpoint('native-shipit-replacement')
  await wait('old-app-exit', () => child.child.exitCode !== null, 120_000)
  const newPid = await wait(
    'new-process-launch',
    async () => (await ownAppPids()).find((pid) => pid !== child.child.pid),
    180_000,
  )
  const installedBuild = (
    await command('/usr/bin/plutil', [
      '-extract',
      'CFBundleVersion',
      'raw',
      '-o',
      '-',
      join(artifact, 'Contents', 'Info.plist'),
    ])
  ).stdout.trim()
  assert(installedBuild === '276', 'installed version is not the pinned target')
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', artifact])
  const afterSignature = await command('/usr/bin/codesign', ['-dv', '--verbose=4', artifact])
  assert(afterSignature.stderr.includes(`TeamIdentifier=${team}`), 'updated app identity changed')
  receipt.upgrade = { installedBuild, freshProcess: true, signatureVerified: true }
  await wait('new-process-google-restoration', async () => {
    const overview = await accounts(seeded.path)
    return overview?.state === 'connected' && overview.client?.source === 'own'
  })
  receipt.providerRequests = providers.stats.requests
  receipt.restored = { googleAccountStateStored: true, ownClientSelected: true }
  receipt.newProcessObserved = Number.isSafeInteger(newPid)
  // The uninspected first post-update process above must restore Google itself.
  // A subsequent cold start independently checks every native encrypted store.
  process.kill(newPid, 'SIGTERM')
  await wait('first-relaunch-exit', async () => (await ownAppPids()).length === 0, 30_000)
  const audit = owned.start(
    join(artifact, 'Contents', 'MacOS', 'Holi'),
    ['--inspect-brk=127.0.0.1:0'],
    {
      cwd: root,
      env: {
        HOME: homedir(),
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        TMPDIR: tmpdir(),
        ...providers.env,
      },
    },
  )
  await attach(audit)
  await evaluate(
    `(() => {
    const { app } = require('electron');
    const fs = require('node:fs/promises');
    const original = fs.readFile;
    let release;
    const inspected = new Promise(resolve => { release = resolve; });
    globalThis.__holi565Audit = null;
    fs.readFile = async function(file, ...args) {
      if (String(file) === ${JSON.stringify(join(profile, 'github-auth.enc'))}) await inspected;
      return original.call(this, file, ...args);
    };
    app.once('ready', async () => {
      fs.readFile = original;
      try {
        globalThis.__holi565Audit = await require(${JSON.stringify(join(bundle, 'producer.cjs'))}).inspectConnections(${JSON.stringify(profile)}, ${JSON.stringify(seeded.remote)});
      } catch { globalThis.__holi565Audit = { failed: true }; }
      finally { release(); }
    });
    return { version: app.getVersion() };
  })()`,
  )
  await inspector.resume()
  receipt.nativeDecryptionCompatibility = await wait('updated-electron-native-readers', () =>
    evaluate('globalThis.__holi565Audit'),
  )
  assert(
    ['github', 'google', 'client', 'vaultBinding', 'speech'].every(
      (key) => receipt.nativeDecryptionCompatibility[key] === true,
    ),
    'a native credential reader did not restore its fixture connection',
  )
  await checkpoint('completed-no-google-disconnect-reproduced')
}

try {
  await main()
} catch (error) {
  if (evidence) {
    receipt.error = {
      type: error.name,
      code: /^[A-Z_]+$/.test(error.code || '') ? error.code : null,
      line: error.stack?.match(/run-connection-upgrade.mjs:(\d+):\d+/)?.[1],
    }
    receipt.failure =
      error instanceof assert.AssertionError
        ? 'workflow assertion failed'
        : receipt.timedOut
          ? 'workflow phase timeout'
          : 'workflow command failed'
    await checkpoint(receipt.phase).catch(() => {})
  }
  console.error('Connection upgrade did not complete; see sanitised result.json')
  process.exitCode = 1
} finally {
  const failures = []
  async function attempt(phase, action) {
    try {
      await action()
      return true
    } catch (error) {
      failures.push({
        phase,
        type: error.name,
        code: /^[A-Z_]+$/.test(error.code || '') ? error.code : null,
      })
      return false
    }
  }
  let drained = false
  let installerDrained = false
  if (installerGuardReady) {
    await attempt('remove-validated-squirrel-job', async () => {
      await installer.removeOwned()
      installerDrained = true
    })
  } else if (!artifact) {
    installerDrained = true
  }
  if (artifact) {
    await attempt('signal-owned-runtime', async () => {
      for (const pid of await ownRuntimePids()) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
    })
  }
  await attempt('stop-owned-groups', () => owned.stopAll())
  await attempt('confirm-process-drain', async () => {
    if (artifact)
      await wait('runtime-cleanup', async () => (await ownRuntimePids()).length === 0, 15_000, true)
    assert(owned.size === 0, 'owned process groups remain')
    drained = true
    inspector?.close()
  })
  if (!drained && owned.size) {
    await attempt('inspect-owned-group-states', async () => {
      const groups = new Set(owned.remainingPids)
      const states = { live: 0, zombie: 0 }
      const result = await command('/bin/ps', ['-axo', 'pgid=,stat='], { cleanup: true })
      for (const line of result.stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\S+)/)
        if (match && groups.has(Number(match[1]))) {
          states[match[2].startsWith('Z') ? 'zombie' : 'live']++
        }
      }
      receipt.cleanupGroupStates = states
    })
  }
  for (const key of launchKeys)
    await attempt(`unset-${key}`, () =>
      command('/bin/launchctl', ['unsetenv', key], { cleanup: true }),
    )
  if (providers) await attempt('provider-shutdown', () => providers.close())
  if (feed) await attempt('feed-shutdown', () => feed.stop())
  if (drained && installerDrained) {
    if (ownsProfile) {
      await attempt('remove-profile', () => rm(profile, { recursive: true, force: true }))
      await attempt('remove-vaults', () => rm(vaultRoot, { recursive: true, force: true }))
    }
    if (root) await attempt('remove-artifacts', () => rm(root, { recursive: true, force: true }))
  }
  if (failures.length) {
    receipt.cleanup = {
      failures,
      filesRetained: !(drained && installerDrained),
      root: !(drained && installerDrained) ? root : undefined,
    }
    if (evidence) await checkpoint(receipt.phase).catch(() => {})
    console.error('Owned upgrade fixture cleanup failed; see sanitised cleanup receipt')
    process.exitCode = 1
  }
}
