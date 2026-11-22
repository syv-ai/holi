import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { release, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finished } from 'node:stream/promises'
import { build } from 'vite'
import { externalizeDepsPlugin } from 'electron-vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? join(tmpdir(), 'holi-372-evidence'))
const resultPath = join(evidence, 'dependency-electron-smoke.json')
const requireDependency = createRequire(import.meta.url)
const { GITHUB_SHA: gitSha, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: runAttempt } = process.env
if (process.env.GITHUB_ACTIONS === 'true') {
  assert.equal(process.platform, 'win32')
  assert(/^[0-9a-f]{40}$/.test(gitSha ?? ''), 'Missing tested GitHub SHA')
  assert(/^[1-9][0-9]*$/.test(runId ?? '') && /^[1-9][0-9]*$/.test(runAttempt ?? ''))
  assert.equal(
    evidence,
    resolve(process.env.RUNNER_TEMP, `windows-agent-${gitSha}-${runId}-${runAttempt}`),
  )
  assert(process.env.HOLI_QA372_PACKAGED_NODE, 'Missing independently verified unpacked-app Node')
}
await mkdir(evidence, { recursive: true })
const assertAbsent = async (path) => {
  try {
    await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`Unexpected existing path: ${path}`)
}
await assertAbsent(resultPath)

async function within(label, pending, ms) {
  let timer
  try {
    return await Promise.race([
      pending,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out (${ms} ms)`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const root = await mkdtemp(join(tmpdir(), 'holi-372-smoke-'))
const failures = new Set()
let result
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
        input: join(desktop, 'scripts/windows-agent-smoke.ts'),
        external: ['electron', 'node-pty'],
        output: {
          format: 'cjs',
          entryFileNames: 'main.cjs',
          banner: `module.paths.unshift(${JSON.stringify(join(desktop, 'node_modules'))});`,
        },
      },
    },
  })
  await writeFile(
    join(root, 'bootstrap.cjs'),
    `process.on('uncaughtException', e => { console.error(e); require('electron').app.exit(1) }); try { require('./main.cjs') } catch(e) { console.error(e); require('electron').app.exit(1) }`,
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-agent-launch-qa-372', main: 'bootstrap.cjs' }),
  )
  const electron = requireDependency('electron')
  const env = {
    ...process.env,
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
    HOLI_QA372_ROOT: await realpath(root),
    HOLI_QA372_DESKTOP: desktop,
    HOLI_QA372_NODE: process.execPath,
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [root], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let exited = false
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      exited = true
      resolve({ code, signal })
    })
  })
  const stdout = finished(child.stdout, { readable: true, writable: false, cleanup: true })
  const stderr = finished(child.stderr, { readable: true, writable: false, cleanup: true })
  void stdout.catch(() => undefined)
  void stderr.catch(() => undefined)
  child.stdout.pipe(process.stdout, { end: false })
  child.stderr.pipe(process.stderr, { end: false })
  try {
    const { code, signal } = await within('Dependency Electron exit', exit, 180_000)
    assert.equal(code, 0, `Disposable dependency Electron smoke failed (signal: ${signal})`)
    await Promise.all([
      within('Dependency Electron stdout', stdout, 8_000),
      within('Dependency Electron stderr', stderr, 8_000),
    ])
    const record = JSON.parse(await readFile(join(root, 'smoke-result.json'), 'utf8'))
    assert.equal(record.ok, true)
    assert.equal(record.runtime, 'dependency-electron')
    assert.equal(record.platform, process.platform)
    assert.equal(record.platformVersion, release())
    assert.equal(record.electron, requireDependency('electron/package.json').version)
    assert(
      Array.isArray(record.checks) &&
        record.checks.length > 0 &&
        record.checks.every((check) => typeof check === 'string'),
    )
    result = {
      ok: true,
      runtime: record.runtime,
      platform: record.platform,
      platformVersion: record.platformVersion,
      electron: record.electron,
      gitSha,
      runId,
      runAttempt,
      checks: record.checks,
      cleanup: { disposableRootRemoved: true },
    }
  } catch (error) {
    failures.add(error)
  } finally {
    if (!exited && child.pid !== undefined) {
      try {
        child.kill('SIGKILL') // The exact Electron ChildProcess, not a rediscovered PID.
        await within('Dependency Electron fallback exit', exit, 8_000)
      } catch (error) {
        failures.add(error)
      }
    }
    child.stdout.destroy()
    child.stderr.destroy()
    child.unref() // A failed fallback must not hang the runner after reporting the failure.
  }
} catch (error) {
  failures.add(error)
} finally {
  try {
    await rm(root, { recursive: true, maxRetries: 3 })
    await assertAbsent(root)
  } catch (error) {
    failures.add(error)
  }
}
if (failures.size) throw new AggregateError([...failures], 'Dependency Electron smoke failed')
const pending = `${resultPath}.tmp`
await writeFile(pending, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
await rename(pending, resultPath)
console.log('Dependency Electron smoke completed and its disposable workspace was removed')
