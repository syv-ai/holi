import { randomUUID } from 'node:crypto'
import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'

import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'vite'
import { createOwnedProcesses } from './owned-processes.mjs'
import { allowNativeNotificationPermission, clickNativeBanner } from './notification-os.mjs'

if (process.platform !== 'darwin') throw new Error('notification readiness requires macOS')
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(desktop, 'package.json'))
const evidence = resolve(process.argv[2] ?? '/tmp/holi-notification-readiness')
const root = await mkdtemp(join(tmpdir(), 'holi-notification-fixture-'))
const profile = join(root, 'profile')
const result = join(root, 'result')
const nonce = randomUUID().replaceAll('-', '')
const appName = `Holi550-${nonce}`
const bundleId = `ai.syv.holi.fixture.run${nonce}`
const title = `Holi readiness ${nonce}`
const ownedApp = join(root, `${appName}.app`)
const ownedBinary = join(ownedApp, 'Contents/MacOS/Electron')
const controller = new AbortController()
const owned = createOwnedProcesses({ signal: controller.signal })
const cleanupProcesses = createOwnedProcesses()
const commandEnv = {
  PATH: process.env.PATH,
  HOME: join(profile, 'home'),
  TMPDIR: join(profile, 'tmp'),
}
const exec = async (command, args) => ({
  stdout: (await owned.run(command, args, { env: commandEnv })).output,
})
const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const interrupt = () => controller.abort(new Error('notification fixture interrupted'))
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
const watchdog = setTimeout(
  () => controller.abort(new Error('notification fixture deadline exceeded')),
  70_000,
)
let child
let artifactsCreated = false
let registered = false
let permissionOutcome
let cleanup = {}
const capture = async (name, operation) => {
  try {
    cleanup[name] = { ok: true, output: (await operation())?.stdout?.trim() ?? '' }
  } catch (error) {
    cleanup[name] = { ok: false, error: String(error) }
  }
}
try {
  await mkdir(join(profile, 'home'), { recursive: true })
  await mkdir(join(profile, 'tmp'), { recursive: true })
  await mkdir(evidence, { mode: 0o700 })
  artifactsCreated = true
  const source = resolve(dirname(await realpath(require('electron'))), '..', '..')
  if (!(await lstat(source)).isDirectory()) throw new Error('Electron app bundle not found')
  await cp(source, ownedApp, { recursive: true, dereference: false, verbatimSymlinks: true })
  const targetRoot = await realpath(ownedApp)
  async function verifyLinks(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await realpath(full)
        if (!target.startsWith(`${targetRoot}/`))
          throw new Error(`bundle symlink escapes copy: ${full}`)
      } else if (entry.isDirectory()) await verifyLinks(full)
    }
  }
  await verifyLinks(ownedApp)
  const plist = join(ownedApp, 'Contents/Info.plist')
  const setPlist = async (key, value) =>
    exec('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist])
  await setPlist('CFBundleIdentifier', bundleId)
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    try {
      await exec('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${appName}`, plist])
    } catch {
      await exec('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${appName}`, plist])
    }
  }
  const appResources = join(ownedApp, 'Contents/Resources/app')
  await mkdir(appResources, { mode: 0o700 })
  await build({
    configFile: false,
    root: desktop,
    logLevel: 'error',
    build: {
      ssr: join(desktop, 'scripts/notification-os-fixture-main.ts'),
      outDir: appResources,
      emptyOutDir: false,
      rollupOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'main.cjs' },
      },
    },
  })
  await writeFile(
    join(appResources, 'package.json'),
    JSON.stringify({
      name: 'holi-notification-fixture',
      productName: appName,
      version: '0.0.0',
      main: 'main.cjs',
    }),
  )
  await exec('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    '--identifier',
    bundleId,
    '--preserve-metadata=entitlements,flags,runtime',
    ownedApp,
  ])
  registered = true
  await exec(lsregister, ['-f', ownedApp])
  child = owned.start(ownedBinary, [], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: join(profile, 'home'),
      TMPDIR: join(profile, 'tmp'),
      ELECTRON_DEBUG_NOTIFICATIONS: '1',
      ELECTRON_ENABLE_LOGGING: '1',
      ELECTRON_LOG_FILE: join(root, 'native.log'),
      HOLI_NOTIFICATION_TITLE: title,
      HOLI_NOTIFICATION_APP_NAME: appName,
      HOLI_NOTIFICATION_RESULT: result,
      HOLI_NOTIFICATION_USER_DATA: join(profile, 'user'),
      HOLI_NOTIFICATION_SESSION_DATA: join(profile, 'session'),
    },
  })
  let permissionClicked = false
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    controller.signal.throwIfAborted()
    if (child.child.exitCode !== null)
      throw new Error(`fixture exited before readiness: ${child.output}`)
    const state = await readFile(result, 'utf8').catch((error) =>
      error.code === 'ENOENT' ? '' : Promise.reject(error),
    )
    if (state.startsWith('native-failed:')) throw new Error(state)
    if (state === 'permission-requested' && !permissionClicked) {
      try {
        permissionOutcome = await allowNativeNotificationPermission({
          appName,
          signal: controller.signal,
        })
      } catch (error) {
        if (!error.message.includes('owned notification consent dialog not found')) throw error
        permissionOutcome = String(error)
      }
      permissionClicked = true
      await new Promise((resolve) => setTimeout(resolve, 500))
      await writeFile(`${result}.send`, 'send')
    }
    if (state === 'shown-native') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const state = await readFile(result, 'utf8').catch(() => '')
  if (state !== 'shown-native') throw new Error(`fixture did not become ready: ${child.output}`)
  const click = await clickNativeBanner({
    appName,
    title,
    timeoutMs: 12_000,
    signal: controller.signal,
  })
  const clickDeadline = Date.now() + 5_000
  let outcome = ''
  while (Date.now() < clickDeadline) {
    controller.signal.throwIfAborted()
    outcome = await readFile(result, 'utf8').catch(() => '')
    if (outcome === 'clicked-and-window-activated') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (outcome !== 'clicked-and-window-activated')
    throw new Error(`native click did not activate fixture window (state=${outcome})`)
  await writeFile(
    join(evidence, 'result.json'),
    `${JSON.stringify({ appName, bundleId, title, permissionOutcome, click, outcome })}\n`,
  )
} catch (error) {
  if (artifactsCreated)
    await writeFile(
      join(evidence, 'result.json'),
      `${JSON.stringify({ appName, bundleId, title, error: String(error), permissionOutcome, nativeLog: await readFile(join(root, 'native.log'), 'utf8').catch(() => null), output: child?.output, nativeState: await readFile(result, 'utf8').catch(() => null) })}\n`,
    )
  throw error
} finally {
  clearTimeout(watchdog)
  await capture('processes', () => owned.stopAll())
  if (registered)
    await capture('unregister', async () => ({
      stdout: (
        await cleanupProcesses.run(lsregister, ['-u', ownedApp], {
          env: commandEnv,
          timeoutMs: 5000,
        })
      ).output,
    }))
  await capture('cleanupProcesses', () => cleanupProcesses.stopAll())
  if (Object.values(cleanup).every((step) => step.ok))
    await capture('runtime', () => rm(root, { recursive: true, force: true }))
  else cleanup.retainedRuntime = root
  if (artifactsCreated)
    await writeFile(join(evidence, 'cleanup.json'), `${JSON.stringify(cleanup)}\n`)
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  if (Object.values(cleanup).some((step) => step?.ok === false))
    throw new Error(`notification cleanup failed: ${JSON.stringify(cleanup)}`)
}
