import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createOwnedProcesses } from './owned-processes.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(desktop, 'package.json'))
const processes = createOwnedProcesses()
const root = await mkdtemp(join(tmpdir(), 'holi-550-owned-'))
const buildRoot = join(root, 'build')
const evidence = await mkdtemp(join(tmpdir(), 'holi-550-evidence-'))
const runtime = join(buildRoot, 'runtime')
const nonce = randomUUID().replaceAll('-', '')
let child
let outcome = 'failed'
let errorText
let cleanup = 'pending'
const systemPath = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
try {
  await mkdir(buildRoot, { mode: 0o700 })
  const outStat = await lstat(join(desktop, 'out')).catch(() => null)
  if (outStat?.isSymbolicLink()) throw new Error('Refusing shared/symlinked desktop out directory')
  const { output: buildLog } = await processes.run(
    process.execPath,
    [join(desktop, 'scripts/build-agent-inbox-550.mjs'), buildRoot],
    { cwd: desktop, env: { PATH: systemPath, HOME: root, TMPDIR: root }, timeoutMs: 80_000 },
  )
  const profile = await realpath(runtime)
  for (const name of [
    'home',
    'tmp',
    'user-data',
    'session-data',
    'app-data',
    'crash-dumps',
    'logs',
    'vaults',
    'bin',
  ])
    await mkdir(join(profile, name), { mode: 0o700 })
  const electron = require('electron')
  if (typeof electron !== 'string' || !electron) throw new Error('Electron executable unavailable')
  const env = {
    PATH: `${join(profile, 'bin')}:${systemPath}`,
    HOME: join(profile, 'home'),
    TMPDIR: join(profile, 'tmp'),
    TMP: join(profile, 'tmp'),
    TEMP: join(profile, 'tmp'),
    XDG_CONFIG_HOME: join(profile, 'home/.config'),
    XDG_CACHE_HOME: join(profile, 'home/.cache'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(profile, 'home/.gitconfig'),
    HOLI_550_ROOT: profile,
    HOLI_550_APP_NAME: `Holi550-${nonce}`,
    HOLI_VAULT_ROOT: join(profile, 'vaults'),
    HOLI_550_NO_PROVIDERS: '1',
  }
  child = processes.start(electron, [join(buildRoot, 'out/main/bootstrap.js')], {
    cwd: buildRoot,
    env,
  })
  const deadline = Date.now() + 60_000
  let paths
  while (Date.now() < deadline) {
    if (child.child.exitCode !== null) throw new Error(`Electron exited early: ${child.output}`)
    paths = await readFile(join(profile, 'paths.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null)
    if (paths) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!paths) throw new Error(`No startup proof before deadline: ${child.output}`)
  outcome = 'main-process-started-no-provider'
  await writeFile(
    join(evidence, 'startup.json'),
    JSON.stringify(
      {
        outcome,
        runtimeRoot: profile,
        isolatedPaths: paths,
        rendererLoaded: false,
        sandboxVerified: false,
        contextIsolationVerified: false,
        providerExecutablesEnabled: false,
        limitation:
          'renderer sandbox proof not instrumented; no native provider or OS-wide containment claimed',
        buildLog: buildLog.slice(-4000),
        processOutput: child.output.slice(-4000),
      },
      null,
      2,
    ),
    { mode: 0o600, flag: 'wx' },
  )
  console.log(`Startup evidence: ${join(evidence, 'startup.json')}`)
} catch (error) {
  errorText = String(error?.stack ?? error)
  console.error(errorText)
} finally {
  try {
    if (child) await processes.stop(child, 1500, 3000)
    cleanup = 'owned child stopped'
  } catch (error) {
    cleanup = `cleanup failed: ${error}`
  }
  await writeFile(
    join(evidence, 'cleanup.json'),
    JSON.stringify({ outcome, error: errorText, cleanup, runtimeRoot: runtime }, null, 2),
    { mode: 0o600, flag: 'wx' },
  ).catch(() => {})
  if (cleanup === 'owned child stopped') await rm(root, { recursive: true, force: true })
  console.log(`Cleanup evidence: ${join(evidence, 'cleanup.json')}`)
}
