import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createOwnedProcesses } from './owned-processes.mjs'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGithubStorageScenarios } from './github-storage-native-scenarios.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(desktop, 'package.json'))
const arg = process.argv.find((value) => value.startsWith('--evidence-dir='))
const evidence = resolve(
  arg?.slice('--evidence-dir='.length) ?? join(process.cwd(), 'github-storage-native-evidence'),
)
const inside = process.argv.includes('--inside')
const root = process.env.HOLI_STORAGE_ROOT
const safeEnvironment = () =>
  Object.fromEntries(
    ['PATH', 'LANG', 'LC_ALL'].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  )
const prerequisites = [
  'xvfb-run',
  'dbus-run-session',
  'dbus-daemon',
  'gdbus',
  'gnome-keyring-daemon',
  'xdotool',
  'Xvfb',
  'xauth',
]
const cancellation = new AbortController()
const processes = createOwnedProcesses({
  signal: cancellation.signal,
  onChange: (pids) => {
    if (inside && root) writeFileSync(join(root, 'owned-pids.json'), JSON.stringify(pids))
  },
})
const outputs = {}
let signalCleanup
let signalCleanupError
let innerCleanupReceipt

for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    process.exitCode = signal === 'SIGINT' ? 130 : 143
    cancellation.abort()
    signalCleanup = processes.stopAll(inside ? 1000 : 6000, 2000).catch((error) => {
      signalCleanupError = error instanceof Error ? error.message : String(error)
    })
  })

function commandExists(command) {
  return (
    spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'check', command], {
      encoding: 'utf8',
      timeout: 2000,
    }).status === 0
  )
}

const start = (command, args, options) =>
  processes.start(command, args, { cwd: desktop, ...options })
const stop = (record) => processes.stop(record)
const run = (command, args, options = {}) =>
  processes.run(command, args, { cwd: desktop, signal: cancellation.signal, ...options })

async function electron(mode, env, timeoutMs = 15000, logName = mode, signal) {
  const electronBin = require('electron')
  let log = ''
  try {
    const result = await run(electronBin, [join(root, 'fixture.cjs')], {
      env: { ...env, HOLI_STORAGE_ROOT: root, HOLI_STORAGE_MODE: mode },
      signal,
      timeoutMs,
      label: `Electron ${mode}`,
    })
    log = result.output
    outputs[`${logName}.log`] = log
    const line = log.split('\n').find((entry) => entry.startsWith('HOLI_STORAGE_RESULT '))
    assert.ok(line, `Electron ${mode} did not report a result`)
    return { ...JSON.parse(line.slice('HOLI_STORAGE_RESULT '.length)), log }
  } catch (error) {
    outputs[`${logName}.log`] =
      log + (error instanceof Error ? `\n${error.message}` : '\nunknown error')
    throw error
  }
}

async function main() {
  await mkdir(dirname(evidence), { recursive: true })
  if (!inside) {
    try {
      await mkdir(evidence)
    } catch (error) {
      throw new Error(`evidence directory must be new and empty: ${evidence}`, { cause: error })
    }
  } else {
    assert.equal(
      (await stat(evidence)).isDirectory(),
      true,
      'wrapper evidence directory is missing',
    )
  }
  let failure
  let scratch
  try {
    if (!inside) {
      assert.equal(process.platform, 'linux', 'native credential acceptance requires Linux')
      const missing = prerequisites.filter((command) => !commandExists(command))
      assert.deepEqual(missing, [], `missing native prerequisites: ${missing.join(', ')}`)
      scratch = await mkdtemp(join(tmpdir(), 'holi-github-storage-'))
      const env = {
        ...safeEnvironment(),
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        HOME: scratch,
        HOLI_STORAGE_ROOT: scratch,
      }
      const launch = await run(
        'xvfb-run',
        [
          '-a',
          'dbus-run-session',
          '--',
          process.execPath,
          fileURLToPath(import.meta.url),
          `--evidence-dir=${evidence}`,
          '--inside',
        ],
        {
          env,
          timeoutMs: 120000,
          label: 'native smoke wrapper',
          stopGraceMs: 6000,
          killGraceMs: 2000,
        },
      )
      innerCleanupReceipt = JSON.parse(
        await readFile(join(scratch, 'cleanup-receipt.json'), 'utf8'),
      )
      assert.equal(
        innerCleanupReceipt.childrenReaped,
        true,
        `inner process cleanup was not confirmed; remaining owned PIDs: ${innerCleanupReceipt.remainingPids?.join(', ') ?? 'unknown'}`,
      )
      assert.deepEqual(innerCleanupReceipt.remainingPids, [])
      await writeFile(join(evidence, 'runner.log'), launch.output)
      process.stdout.write(launch.output)
      return
    }
    const result = await runGithubStorageScenarios({
      root,
      start,
      stop,
      electron,
    })
    await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
    console.log(`Native GitHub storage acceptance passed; evidence: ${evidence}`)
  } catch (error) {
    failure = error
    if (!inside)
      outputs['runner.log'] =
        error instanceof Error ? (error.stack ?? error.message) : String(error)
    throw error
  } finally {
    const cleanupErrors = []
    if (signalCleanup) await signalCleanup
    if (signalCleanupError) cleanupErrors.push(signalCleanupError)
    try {
      await processes.stopAll()
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error))
    }
    if (inside && root) await rm(join(root, 'github-auth.enc'), { force: true })
    if (inside && root) {
      const receipt = {
        childrenReaped: processes.size === 0,
        remainingPids: processes.remainingPids,
        cleanupErrors,
      }
      try {
        await writeFile(join(root, 'cleanup-receipt.json'), JSON.stringify(receipt, null, 2))
      } catch (error) {
        cleanupErrors.push(
          `could not write cleanup receipt: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (cleanupErrors.length) {
      const cleanupMessage = `process cleanup failed: ${cleanupErrors.join('; ')}`
      failure =
        failure instanceof Error
          ? new Error(`${failure.message}\n${cleanupMessage}`, { cause: failure })
          : new Error(cleanupMessage)
    }
    if (failure)
      await writeFile(
        join(evidence, inside ? 'failure.json' : 'wrapper-failure.json'),
        JSON.stringify(
          { error: failure instanceof Error ? failure.message : String(failure), outputs },
          null,
          2,
        ),
      )
    for (const [name, contents] of Object.entries(outputs))
      await writeFile(join(evidence, name), contents)
    if (!inside && scratch) {
      let lastOwnedInnerPids
      try {
        lastOwnedInnerPids = JSON.parse(await readFile(join(scratch, 'owned-pids.json'), 'utf8'))
      } catch {}
      try {
        innerCleanupReceipt ??= JSON.parse(
          await readFile(join(scratch, 'cleanup-receipt.json'), 'utf8'),
        )
        assert.equal(
          innerCleanupReceipt.childrenReaped,
          true,
          `inner cleanup did not confirm all children reaped; remaining owned PIDs: ${innerCleanupReceipt.remainingPids?.join(', ') ?? 'unknown'}`,
        )
        assert.deepEqual(innerCleanupReceipt.remainingPids, [])
        assert.deepEqual(innerCleanupReceipt.cleanupErrors, [])
        assert.equal(processes.size, 0, 'refusing to remove scratch while wrapper children remain')
        await rm(scratch, { recursive: true, force: true })
        await writeFile(
          join(evidence, 'cleanup.json'),
          JSON.stringify(
            { scratchRemoved: true, childrenReaped: true, completed: !failure },
            null,
            2,
          ),
        )
      } catch (error) {
        const cleanupMessage = `refusing to remove scratch without positive inner cleanup confirmation: ${error instanceof Error ? error.message : String(error)}; wrapper remaining PIDs: ${processes.remainingPids.join(', ') || 'none'}`
        failure =
          failure instanceof Error
            ? new Error(`${failure.message}\n${cleanupMessage}`, { cause: failure })
            : new Error(cleanupMessage)
        await writeFile(
          join(evidence, 'cleanup.json'),
          JSON.stringify(
            {
              scratchRemoved: false,
              childrenReaped: false,
              remainingInnerPids: innerCleanupReceipt?.remainingPids ?? null,
              lastTrackedInnerPids: lastOwnedInnerPids ?? null,
              remainingWrapperPids: processes.remainingPids,
              error: cleanupMessage,
            },
            null,
            2,
          ),
        )
      }
    }
    if (!inside && failure)
      await writeFile(
        join(evidence, 'wrapper-failure.json'),
        JSON.stringify(
          { error: failure instanceof Error ? failure.message : String(failure), outputs },
          null,
          2,
        ),
      )
    if (cleanupErrors.length && !process.exitCode)
      throw new Error(`process cleanup failed: ${cleanupErrors.join('; ')}`)
    if (failure && !process.exitCode) throw failure
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
