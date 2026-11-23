import { randomUUID } from 'node:crypto'
import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'vite'
import { createOwnedProcesses } from './owned-processes.mjs'
import { clickNativeBanner } from './notification-os.mjs'

if (process.platform !== 'darwin') throw new Error('notification readiness requires macOS')
const exec = promisify(execFile)
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(desktop, 'package.json'))
const evidence = resolve(process.argv[2] ?? '/tmp/holi-notification-readiness')
const root = await mkdtemp(join(tmpdir(), 'holi-notification-fixture-'))
const profile = join(root, 'profile')
const result = join(root, 'result')
const nonce = randomUUID().replaceAll('-', '')
const appName = `Holi Notification Fixture ${nonce}`
const bundleId = `ai.syv.holi.fixture.${nonce}`
const title = `Holi readiness ${nonce}`
const ownedApp = join(root, `${appName}.app`)
const ownedBinary = join(ownedApp, 'Contents/MacOS/Electron')
const owned = createOwnedProcesses()
let child
let artifactsCreated = false
let registered = false
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
  await mkdir(evidence, { recursive: true, mode: 0o700 })
  artifactsCreated = true
  const source = realpathSync(require('electron'))
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
  await exec('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', ownedApp])
  await exec(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', ownedApp],
  )
  registered = true
  await build({
    configFile: false,
    root: desktop,
    logLevel: 'error',
    build: {
      ssr: join(desktop, 'scripts/notification-os-fixture-main.ts'),
      outDir: root,
      emptyOutDir: false,
      rollupOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'main.cjs' },
      },
    },
  })
  child = owned.start(ownedBinary, [join(root, 'main.cjs')], {
    env: {
      PATH: process.env.PATH,
      HOME: join(profile, 'home'),
      TMPDIR: join(profile, 'tmp'),
      HOLI_NOTIFICATION_TITLE: title,
      HOLI_NOTIFICATION_APP_NAME: appName,
      HOLI_NOTIFICATION_RESULT: result,
      HOLI_NOTIFICATION_USER_DATA: join(profile, 'user'),
      HOLI_NOTIFICATION_SESSION_DATA: join(profile, 'session'),
    },
  })
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const state = await readFile(result, 'utf8').catch((error) =>
      error.code === 'ENOENT' ? '' : Promise.reject(error),
    )
    if (state.startsWith('native-failed:')) throw new Error(state)
    if (state.startsWith('shown')) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const state = await readFile(result, 'utf8').catch(() => '')
  if (!state.startsWith('shown')) throw new Error(`fixture did not become ready: ${child.output}`)
  const click = await clickNativeBanner({ appName, title, timeoutMs: 12_000 })
  const clickDeadline = Date.now() + 5_000
  let outcome = ''
  while (Date.now() < clickDeadline) {
    outcome = await readFile(result, 'utf8').catch(() => '')
    if (outcome === 'clicked-and-window-activated') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (outcome !== 'clicked-and-window-activated')
    throw new Error(`native click did not activate fixture window (state=${outcome})`)
  await writeFile(
    join(evidence, 'result.json'),
    `${JSON.stringify({ appName, bundleId, title, click, outcome })}\n`,
  )
} catch (error) {
  if (artifactsCreated)
    await writeFile(
      join(evidence, 'result.json'),
      `${JSON.stringify({ appName, bundleId, title, error: String(error), output: child?.output, nativeState: await readFile(result, 'utf8').catch(() => null) })}\n`,
    )
} finally {
  await owned.stopAll()
  if (registered)
    await capture('unregister', () =>
      exec(
        '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
        ['-u', ownedApp],
      ),
    )
  await rm(root, { recursive: true, force: true }).then(
    () => (cleanup.deleted = true),
    (error) => (cleanup.deleteError = String(error)),
  )
  if (artifactsCreated)
    await writeFile(join(evidence, 'cleanup.json'), `${JSON.stringify(cleanup)}\n`)
}
function realpathSync(path) {
  return require('node:fs').realpathSync(path)
}
