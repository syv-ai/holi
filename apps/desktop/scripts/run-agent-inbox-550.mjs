import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as pause } from 'node:timers/promises'
import { createOwnedProcesses } from './owned-processes.mjs'

// This startup gate launches no providers. Main is trusted fixture code, not
// OS-network-contained; production Chromium sandboxing remains enabled.
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(desktop, 'package.json'))
const destination = process.argv[2]
if (destination && !isAbsolute(destination)) throw new Error('Evidence path must be absolute')
const evidence = destination
  ? (await mkdir(destination, { mode: 0o700 }), await realpath(destination))
  : await realpath(await mkdtemp(join(tmpdir(), 'holi-550-evidence-')))
const root = await realpath(await mkdtemp(join(tmpdir(), 'holi-550-owned-')))
const buildRoot = join(root, 'build')
const runtime = join(buildRoot, 'runtime')
const controller = new AbortController()
const interrupt = () => controller.abort(new Error('Startup interrupted'))
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)
const processes = createOwnedProcesses({ signal: controller.signal })
const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin'
let child
let failure
let proof
let paths
let buildLog = ''
try {
  const build = await processes.run(
    process.execPath,
    [join(desktop, 'scripts/build-agent-inbox-550.mjs'), buildRoot],
    { cwd: desktop, env: { PATH: systemPath, HOME: root, TMPDIR: root }, timeoutMs: 240_000 },
  )
  buildLog = build.output
  const profile = await realpath(runtime)
  const bin = join(profile, 'bin')
  await mkdir(bin, { mode: 0o700 })
  for (const name of ['claude', 'codex', 'pi']) {
    await writeFile(
      join(bin, name),
      '#!/bin/sh\necho "Native providers are disabled in the startup gate" >&2\nexit 126\n',
      { mode: 0o700, flag: 'wx' },
    )
  }
  const home = join(profile, 'home')
  await mkdir(home, { mode: 0o700 })
  await mkdir(join(profile, 'tmp'), { mode: 0o700 })
  const env = {
    PATH: `${bin}:${systemPath}`,
    HOME: home,
    TMPDIR: join(profile, 'tmp'),
    TMP: join(profile, 'tmp'),
    TEMP: join(profile, 'tmp'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local/share'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    HOLI_CLAUDE_BIN: join(bin, 'claude'),
    HOLI_CODEX_BIN: join(bin, 'codex'),
    HOLI_550_ROOT: profile,
    HOLI_550_APP_NAME: `Holi550-${randomUUID().replaceAll('-', '')}`,
    HOLI_VAULT_ROOT: join(profile, 'vaults'),
  }
  await processes.run(process.execPath, [join(buildRoot, 'out/main/seed.js'), profile], {
    cwd: buildRoot,
    env,
    timeoutMs: 30_000,
  })
  const electron = require('electron')
  if (typeof electron !== 'string' || !electron) throw new Error('Electron executable unavailable')
  child = processes.start(electron, [join(buildRoot, 'out/main/bootstrap.js')], {
    cwd: buildRoot,
    env,
  })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const rejected = await readFile(join(profile, 'startup-failure.json'), 'utf8').catch(() => null)
    if (rejected) throw new Error(`Production startup rejected: ${rejected}`)
    proof = await readFile(join(profile, 'startup-ready.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null)
    if (proof) break
    if (child.child.exitCode !== null || child.child.signalCode !== null)
      throw new Error(`Electron exited before renderer readiness: ${child.output}`)
    await pause(100, undefined, { signal: controller.signal })
  }
  if (!proof || !proof.rendererLoaded || !proof.sandboxed || !proof.contextIsolated)
    throw new Error('Production renderer/sandbox startup proof missing after 90,000ms')
  paths = JSON.parse(await readFile(join(profile, 'paths.json'), 'utf8'))
  for (const path of Object.values(paths))
    if (typeof path !== 'string' || !(await realpath(path)).startsWith(`${profile}/`))
      throw new Error('Electron path escaped the owned profile')
} catch (error) {
  failure = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  let cleanupFailure
  try {
    await processes.stopAll(1500, 3000)
    await rm(root, { recursive: true, force: true })
  } catch (error) {
    cleanupFailure = String(error)
    process.exitCode = 1
  }
  await writeFile(
    join(evidence, 'startup.json'),
    JSON.stringify(
      {
        outcome:
          !failure && !cleanupFailure ? 'production-renderer-started-no-providers' : 'failed',
        error: failure,
        runtimeRoot: runtime,
        isolatedPaths: paths,
        proof,
        providerExecutablesEnabled: false,
        mainProcessOsNetworkContainment: false,
        buildLog: buildLog.slice(-8000),
        processOutput: child?.output.slice(-12000),
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  )
  await writeFile(
    join(evidence, 'cleanup.json'),
    JSON.stringify(
      {
        removed: !cleanupFailure,
        error: cleanupFailure,
        remainingPids: processes.remainingPids,
        ownedRoot: root,
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  )
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', interrupt)
  console.log(`Startup evidence: ${evidence}`)
  if (failure) console.error(failure)
  if (cleanupFailure) console.error(cleanupFailure)
}
