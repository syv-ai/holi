import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const desktop = fileURLToPath(new URL('..', import.meta.url))
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const safeEnvironment = () =>
  Object.fromEntries(
    ['PATH', 'LANG', 'LC_ALL'].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  )

function sync(command, args, timeout = 2000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, env: process.env })
  if (result.error) throw result.error
  return result
}

async function unlock(start) {
  const proc = start('gnome-keyring-daemon', ['--foreground', '--unlock', '--components=secrets'], {
    input: 'synthetic-fixture-keyring-password',
  })
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const owner = sync('gdbus', [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.DBus',
      '--object-path',
      '/org/freedesktop/DBus',
      '--method',
      'org.freedesktop.DBus.GetConnectionUnixProcessID',
      'org.freedesktop.secrets',
    ])
    const pid = owner.stdout.match(/uint32 (\d+)/)?.[1]
    if (owner.status === 0 && Number(pid) === proc.child.pid) return { proc, values: {} }
    const ended = await Promise.race([
      proc.exited.then(
        () => true,
        () => true,
      ),
      sleep(100).then(() => false),
    ])
    if (ended) throw new Error(`keyring daemon exited before unlock: ${proc.output}`)
  }
  throw new Error(`owned keyring daemon did not acquire Secret Service: ${proc.output}`)
}

async function cancelNativePrompt(signal) {
  const deadline = Date.now() + 12000
  let cancelled = 0
  while (Date.now() < deadline) {
    if (signal.aborted) {
      assert.ok(cancelled > 0, 'native GNOME keyring unlock prompt did not appear')
      return cancelled
    }
    const found = sync('xdotool', ['search', '--onlyvisible', '--class', 'gcr-prompter'], 1500)
    for (const windowId of found.stdout.trim().split('\n').filter(Boolean)) {
      const name = sync('xdotool', ['getwindowname', windowId], 1500)
      if (name.stdout.trim() !== 'Unlock Login Keyring') continue
      assert.equal(
        sync('xdotool', ['windowfocus', '--sync', windowId], 1500).status,
        0,
        'could not focus native keyring prompt',
      )
      assert.equal(
        sync('xdotool', ['key', 'Escape'], 1500).status,
        0,
        'could not cancel native keyring prompt',
      )
      cancelled++
      break
    }
    await sleep(100)
  }
  throw new Error('native GNOME keyring operation did not settle after prompt cancellation')
}

const digest = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

/**
 * Run the isolated Linux keyring scenarios. Process creation and cleanup remain owned by
 * the entry runner; start/stop/electron are its supervised adapters and signal is run-wide.
 */
export async function runGithubStorageScenarios({ root, start, stop, electron }) {
  assert.ok(root, 'isolated fixture root missing')
  const xdg = {
    ...safeEnvironment(),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HOME: root,
    HOLI_STORAGE_ROOT: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    XDG_CURRENT_DESKTOP: 'GNOME',
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY,
  }
  Object.assign(process.env, xdg)
  for (const directory of [
    root,
    xdg.XDG_CONFIG_HOME,
    xdg.XDG_DATA_HOME,
    xdg.XDG_CACHE_HOME,
    xdg.XDG_RUNTIME_DIR,
    join(xdg.XDG_DATA_HOME, 'keyrings'),
  ])
    await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(root, 'config', 'user-dirs.dirs'), '')
  await build({
    configFile: false,
    root: desktop,
    logLevel: 'error',
    build: {
      ssr: join(desktop, 'scripts/github-storage-native-smoke-main.ts'),
      outDir: root,
      emptyOutDir: false,
      rollupOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'fixture.cjs' },
      },
    },
    ssr: { noExternal: true, external: ['electron'] },
  })

  const keyring = await unlock(start)
  const keyringEnv = { ...xdg, ...keyring.values }
  const signIn = await electron('sign-in', keyringEnv, 15000, 'unlocked-sign-in')
  assert.equal(signIn.backend, 'gnome_libsecret')
  assert.equal(signIn.encryptionAvailable, true)
  assert.equal(signIn.outcome, 'granted')
  assert.equal(signIn.fileExists, true)
  assert.equal(signIn.fileMode, 0o600)
  assert.equal(signIn.rawSecret, false)
  assert.equal(signIn.decodedSecret, false)
  assert.equal(signIn.hasToken, true)
  assert.equal(signIn.hasViewer, true)
  const restore = await electron('restore', keyringEnv, 15000, 'unlocked-restore')
  assert.equal(restore.restoredViewer, true)
  assert.equal(restore.hasToken, true)
  assert.deepEqual(restore.requests, [], 'offline restore must not make fixture requests')
  const savedCredential = await digest(join(root, 'github-auth.enc'))
  const scenarios = {
    unlocked: {
      backend: signIn.backend,
      available: true,
      encrypted0600: true,
      freshProcessRestore: true,
      restoreRequests: 0,
    },
  }

  const lockedBus = sync(
    'gdbus',
    [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.secrets',
      '--object-path',
      '/org/freedesktop/secrets',
      '--method',
      'org.freedesktop.Secret.Service.Lock',
      "[objectpath '/org/freedesktop/secrets/collection/login']",
    ],
    5000,
  )
  assert.equal(lockedBus.status, 0, 'could not lock fixture keyring')
  const promptAbort = new AbortController()
  const lockedPromise = electron(
    'sign-in',
    keyringEnv,
    20000,
    'locked-cancel',
    promptAbort.signal,
  ).finally(() => promptAbort.abort())
  const promptPromise = cancelNativePrompt(promptAbort.signal).catch((error) => {
    promptAbort.abort()
    throw error
  })
  const [lockedOutcome, promptOutcome] = await Promise.allSettled([lockedPromise, promptPromise])
  if (lockedOutcome.status === 'rejected' || promptOutcome.status === 'rejected') {
    await Promise.allSettled([lockedPromise, promptPromise])
    throw lockedOutcome.status === 'rejected' ? lockedOutcome.reason : promptOutcome.reason
  }
  const locked = lockedOutcome.value
  assert.equal(locked.backend, 'gnome_libsecret')
  assert.equal(locked.encryptionAvailable, false)
  assert.equal(locked.error?.name, 'EncryptionUnavailableError')
  assert.equal(locked.error?.phase, 'availability')
  assert.equal(locked.error?.backend, 'gnome_libsecret')
  assert.equal(locked.fileExists, true)
  assert.equal(
    await digest(join(root, 'github-auth.enc')),
    savedCredential,
    'locked keyring changed existing credential',
  )
  assert.equal(locked.hasToken, false)
  assert.equal(locked.hasViewer, false)
  scenarios.locked = {
    backend: locked.backend,
    phase: locked.error.phase,
    cancelledWithoutChangingCredential: true,
    nativePromptsCancelled: promptOutcome.value,
  }

  await stop(keyring.proc)
  const resumed = await unlock(start)
  const resumedEnv = { ...xdg, ...resumed.values }
  const recovery = await electron('restore', resumedEnv, 15000, 'unlocked-recovery')
  assert.equal(recovery.restoredViewer, true)
  assert.deepEqual(recovery.requests, [], 'recovery restore must not make fixture requests')
  assert.equal(await digest(join(root, 'github-auth.enc')), savedCredential)
  scenarios.recovery = { freshProcessRestore: true, requests: 0, credentialUnchanged: true }

  const emptyServices = join(root, 'empty-services')
  await mkdir(emptyServices, { recursive: true })
  const busConfig = join(root, 'isolated-bus.conf')
  await writeFile(
    busConfig,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd"><busconfig><type>session</type><listen>unix:tmpdir=${root}</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy><servicedir>${emptyServices}</servicedir></busconfig>`,
  )
  let bus
  try {
    bus = start('dbus-daemon', ['--config-file', busConfig, '--nofork', '--print-address=1'], {
      env: { ...resumedEnv, DBUS_SESSION_BUS_ADDRESS: undefined },
    })
    const deadline = Date.now() + 5000
    while (!bus.output.trim() && Date.now() < deadline) await sleep(50)
    const address = bus.output.trim().split('\n')[0]
    assert.ok(address, 'isolated DBus did not start')
    const noService = await electron(
      'sign-in',
      { ...resumedEnv, DBUS_SESSION_BUS_ADDRESS: address },
      15000,
      'no-service',
    )
    assert.equal(noService.backend, 'gnome_libsecret')
    assert.equal(noService.encryptionAvailable, false)
    assert.equal(noService.error?.name, 'EncryptionUnavailableError')
    assert.equal(noService.error?.phase, 'availability')
    assert.equal(noService.error?.backend, 'gnome_libsecret')
    assert.equal(noService.fileExists, true)
    assert.equal(
      await digest(join(root, 'github-auth.enc')),
      savedCredential,
      'missing service changed existing credential',
    )
    assert.equal(noService.hasToken, false)
    assert.equal(noService.hasViewer, false)
    scenarios.noService = {
      backend: noService.backend,
      phase: noService.error.phase,
      credentialUnchanged: true,
    }
  } finally {
    await stop(bus)
  }

  const noBus = await electron(
    'sign-in',
    { ...resumedEnv, DBUS_SESSION_BUS_ADDRESS: '' },
    15000,
    'no-bus',
  )
  assert.equal(noBus.backend, 'gnome_libsecret')
  assert.equal(noBus.encryptionAvailable, false)
  assert.equal(noBus.error?.name, 'EncryptionUnavailableError')
  assert.equal(noBus.error?.phase, 'availability')
  assert.equal(noBus.error?.backend, 'gnome_libsecret')
  assert.equal(noBus.fileExists, true)
  assert.equal(
    await digest(join(root, 'github-auth.enc')),
    savedCredential,
    'missing bus changed existing credential',
  )
  assert.equal(noBus.hasToken, false)
  assert.equal(noBus.hasViewer, false)
  assert.match(noBus.error.message, /Linux (?:login )?keyring/i)
  assert.match(noBus.error.message, /session bus/i)
  assert.match(noBus.error.message, /installed|running|unlocked/i)
  assert.equal(noBus.error.message.includes('holi-native-fixture-token-never-valid'), false)
  assert.equal(noBus.error.message.includes('synthetic'), false)
  scenarios.noBus = {
    backend: noBus.backend,
    phase: noBus.error.phase,
    diagnosticCredentialFree: true,
    credentialUnchanged: true,
  }
  return { platform: process.platform, electron: signIn.electron, scenarios }
}
