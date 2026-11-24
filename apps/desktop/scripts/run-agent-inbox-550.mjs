import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createOwnedProcesses } from './owned-processes.mjs'

// Startup reproduction only. This isolates Holi's paths and identity, not the
// trusted fixture main process from OS networking. No real providers are enabled.
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(desktop, 'package.json'))
const output = resolve(process.argv[2] ?? join(tmpdir(), 'holi-550-startup-evidence'))
const nonce = randomUUID().replaceAll('-', '')
const root = await mkdtemp(join(tmpdir(), 'holi-550-runtime-'))
const runtime = join(root, 'runtime')
const processes = createOwnedProcesses()
let child
let success = false
try {
  if ((await lstat(join(desktop, 'out')).catch(() => null))?.isSymbolicLink())
    throw new Error('Refusing shared/symlinked desktop out directory')
  await mkdir(runtime, { mode: 0o700 })
  await mkdir(output, { recursive: true, mode: 0o700 })
  const { output: buildLog } = await processes.run(process.execPath, [
    join(desktop, 'scripts/build-agent-inbox-550.mjs'), runtime,
  ], { cwd: desktop, env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeoutMs: 80_000 })
  const profile = join(runtime, 'runtime')
  for (const name of ['home', 'tmp', 'user-data', 'session-data', 'app-data', 'crash-dumps', 'logs', 'vaults'])
    await mkdir(join(profile, name), { recursive: true, mode: 0o700 })
  const electron = require('electron')
  if (typeof electron !== 'string' || !electron) throw new Error('Electron executable unavailable')
  const env = {
    PATH: process.env.PATH,
    HOME: join(profile, 'home'),
    TMPDIR: join(profile, 'tmp'),
    HOLI_550_ROOT: profile,
    HOLI_550_APP_NAME: `Holi550-${nonce}`,
    HOLI_VAULT_ROOT: join(profile, 'vaults'),
  }
  child = processes.start(electron, [join(runtime, 'out/main/bootstrap.js')], { cwd: runtime, env })
  const deadline = Date.now() + 60_000
  let paths
  while (Date.now() < deadline) {
    if (child.child.exitCode !== null) throw new Error(`Electron exited early: ${child.output}`)
    paths = await readFile(join(profile, 'paths.json'), 'utf8').then(JSON.parse).catch(() => null)
    if (paths) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!paths) throw new Error(`No isolated path proof before deadline: ${child.output}`)
  const report = { outcome: 'main-process-started', runtimeRoot: profile, isolatedPaths: paths, rendererLoaded: false, sandboxVerified: false, contextIsolationVerified: false, providerExecutablesEnabled: false, networkContainment: 'not established; no provider launched', buildLog: buildLog.slice(-4000), processOutput: child.output.slice(-4000) }
  await writeFile(join(output, 'startup.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  success = true
  console.log(`Startup evidence: ${join(output, 'startup.json')}`)
} finally {
  if (child) await processes.stop(child, 1500, 3000)
  await rm(root, { recursive: true, force: true })
  if (!success) console.error('Owned runtime removed; startup reproduction did not complete.')
}
