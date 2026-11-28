import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'vite'
import { externalizeDepsPlugin } from 'electron-vite'

const [packageOutput, receiptArg] = process.argv.slice(2)
assert(packageOutput && receiptArg, 'Expected packaged output directory and receipt path')
assert.equal(process.platform, 'win32', 'Packaged CLI acceptance requires native Windows')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run only on a disposable GitHub runner')
const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
assert.match(checkoutSha, /^[0-9a-f]{40}$/)
assert.equal(checkoutSha, process.env.GITHUB_SHA)
const headSha = process.env.HOLI_PR_HEAD_SHA
assert.match(headSha ?? '', /^[0-9a-f]{40}$/)
for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'])
  assert.match(process.env[key] ?? '', /^[1-9][0-9]*$/)
const desktop = fileURLToPath(new URL('../', import.meta.url))
const appRoot = path.resolve(packageOutput, 'win-unpacked')
const appExe = path.join(appRoot, 'Holi.exe')
const asarFile = path.join(appRoot, 'resources', 'app.asar')
const packagedHelper = path.join(appRoot, 'resources', 'holi.exe')
const packagedNode = path.join(
  appRoot,
  'resources',
  'app.asar.unpacked',
  'node_modules',
  'node-win-x64',
  'bin',
  'node.exe',
)
const systemRoot = process.env.SystemRoot
assert(systemRoot, 'SystemRoot is required')
const cmd = path.join(systemRoot, 'System32', 'cmd.exe')
const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
for (const file of [appExe, asarFile, packagedHelper, packagedNode, cmd, powershell])
  assert(existsSync(file), 'A packaged or native prerequisite is missing')
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const root = mkdtempSync(path.join(tmpdir(), 'Holi packaged CLI café '))
const profile = path.join(root, 'profile')
const launcher = path.join(profile, 'bin', 'holi.exe')
const endpoint = path.join(profile, 'cli-endpoint.json')
const records = new Set()
let startOwned, joinOwned, result
const env = { ...process.env }
for (const key of Object.keys(env))
  if (key.toUpperCase() === 'PATH' || key === 'ELECTRON_RUN_AS_NODE') delete env[key]
Object.assign(env, {
  PATH: path.join(systemRoot, 'System32'),
  HOME: root,
  USERPROFILE: root,
  APPDATA: path.join(root, 'roaming'),
  LOCALAPPDATA: path.join(root, 'local'),
  TEMP: path.join(root, 'temp'),
  TMP: path.join(root, 'temp'),
  HOLI_BIN: launcher,
})
for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.TEMP])
  mkdirSync(directory, { recursive: true })

async function bounded(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
function start(program, args, cwd = root) {
  const child = startOwned(program, args, { cwd, env, stdio: 'pipe', windowsHide: true })
  const record = { child, settled: false, stdout: '', stderr: '' }
  record.done = joinOwned(child, 'win32')
  record.done.then(
    () => {
      record.settled = true
    },
    () => {
      record.settled = true
    },
  )
  record.done.catch(() => {})
  child.stdout.on('data', (chunk) => {
    record.stdout = (record.stdout + chunk).slice(-262144)
  })
  child.stderr.on('data', (chunk) => {
    record.stderr = (record.stderr + chunk).slice(-262144)
  })
  child.stdin.on('error', () => {})
  child.stdin.end()
  records.add(record)
  return record
}
async function stop(record) {
  if (!record.settled) record.child.kill()
  try {
    const outcome = await bounded(record.done, 15000, 'Authenticated process drainage')
    assert.equal(outcome.ownership, 'empty', 'Native ownership was not proved empty')
    assert.equal(outcome.error, null, 'Owned output did not settle cleanly')
    records.delete(record)
    return outcome
  } catch (error) {
    if (error?.lease) await error.lease.revoke()
    throw error
  }
}
async function run(program, args, expectedCode = 0) {
  const record = start(program, args)
  try {
    const outcome = await bounded(record.done, 30000, 'Native caller')
    assert.equal(outcome.code, expectedCode, 'Unexpected native caller exit status')
    assert.equal(outcome.error, null, 'Native caller output failed')
    assert.equal(outcome.ownership, 'empty', 'Native caller descendants did not drain')
    return { stdout: record.stdout, stderr: record.stderr }
  } finally {
    await stop(record)
  }
}
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`
async function proveCallers() {
  const callers = [
    [
      'cmd',
      (args) =>
        run(packagedNode, [
          '-e',
          `const r=require('node:child_process').spawnSync(process.argv[1],process.argv.slice(2),{encoding:'utf8',windowsVerbatimArguments:true});if(r.error)process.exit(1);process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1)`,
          '--',
          cmd,
          '/d',
          '/s',
          '/c',
          `""${launcher}" ${args.map((value) => `"${value}"`).join(' ')}"`,
        ]),
    ],
    [
      'powershell',
      (args) =>
        run(powershell, [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;& $env:HOLI_BIN ${args.map(psQuote).join(' ')};exit $LASTEXITCODE`,
        ]),
    ],
    [
      'node',
      (args) =>
        run(packagedNode, [
          '-e',
          `const r=require('node:child_process').spawnSync(process.env.HOLI_BIN,process.argv.slice(1),{encoding:'utf8'});if(r.error)process.exit(1);process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1)`,
          '--',
          ...args,
        ]),
    ],
  ]
  const outcomes = {}
  for (const [name, call] of callers) {
    const reply = await call(['vault', 'list', '--json'])
    assert.deepEqual(JSON.parse(reply.stdout), [], 'Fresh profile must have no vaults')
    assert.equal(reply.stderr, '', 'Read-only CLI command produced an error')
    outcomes[name] = true
  }
  const unicode = "unexpected café 'quoted'"
  const failure = await run(launcher, ['vault', 'list', unicode], 2)
  assert(failure.stderr.includes(unicode), 'The CLI did not preserve the Unicode usage argument')
  return { ...outcomes, unicodeUsageError: true }
}
async function launchApp() {
  const app = start(appExe, [`--user-data-dir=${profile}`], appRoot)
  const deadline = Date.now() + 120000
  while (!existsSync(endpoint) || !existsSync(launcher)) {
    assert(!app.settled, 'Packaged app exited before installing the CLI')
    assert(Date.now() < deadline, 'Packaged app did not install its CLI before the deadline')
    await delay(250)
  }
  const actualProfile = realpathSync(profile) + path.sep
  for (const file of [endpoint, launcher])
    assert(
      realpathSync(file).startsWith(actualProfile),
      'Generated CLI escaped the disposable profile',
    )
  const descriptor = JSON.parse(readFileSync(endpoint, 'utf8'))
  assert.equal(descriptor.host, '127.0.0.1')
  assert(Number.isInteger(descriptor.port) && descriptor.port > 0 && descriptor.port <= 65535)
  assert.match(descriptor.token, /^[0-9a-f]{64}$/)
  assert.equal(
    hash(launcher),
    hash(packagedHelper),
    'Installed helper differs from packaged helper',
  )
  const runtime = readFileSync(path.join(profile, 'bin', 'holi-runtime.txt'), 'utf16le').replace(
    /^\uFEFF/,
    '',
  )
  assert.equal(
    realpathSync(runtime),
    realpathSync(packagedNode),
    'Installed CLI did not select the packaged runtime',
  )
  return app
}
try {
  const entry = path.join(root, 'ownership-entry.ts')
  writeFileSync(
    entry,
    `export {spawnOwnedProgram} from ${JSON.stringify(path.join(desktop, 'src/main/owned-process.ts'))};export {joinOwnedProgram} from ${JSON.stringify(path.join(desktop, 'src/main/owned-program-lifetime.ts'))};`,
  )
  await build({
    configFile: false,
    root: desktop,
    plugins: [externalizeDepsPlugin({ exclude: ['@holi/shared'] })],
    build: {
      ssr: true,
      target: 'node24',
      outDir: path.join(root, 'ownership'),
      emptyOutDir: false,
      rollupOptions: {
        input: entry,
        preserveEntrySignatures: 'strict',
        output: {
          format: 'cjs',
          entryFileNames: 'owned.cjs',
          banner: `module.paths.unshift(${JSON.stringify(path.join(desktop, 'node_modules'))});`,
        },
      },
    },
  })
  const require = createRequire(import.meta.url)
  const ownership = require(path.join(root, 'ownership', 'owned.cjs'))
  startOwned = ownership.spawnOwnedProgram
  joinOwned = ownership.joinOwnedProgram
  const app = await launchApp()
  const callers = await proveCallers()
  const clientHash = hash(path.join(profile, 'bin', 'holi-client.cjs'))
  await stop(app)
  rmSync(endpoint)
  writeFileSync(path.join(profile, 'bin', 'holi-client.cjs'), 'process.exit(91)\n')
  const restarted = await launchApp()
  const refreshed = await proveCallers()
  assert.equal(
    hash(path.join(profile, 'bin', 'holi-client.cjs')),
    clientHash,
    'Startup did not regenerate the launcher client',
  )
  await stop(restarted)
  const version = await run(packagedNode, ['--version'])
  const builderRequire = createRequire(require.resolve('electron-builder'))
  const asarRequire = createRequire(builderRequire.resolve('app-builder-lib'))
  const asar = asarRequire('@electron/asar')
  const appPackage = JSON.parse(asar.extractFile(asarFile, 'package.json').toString('utf8'))
  result = {
    checkoutSha,
    headSha,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    appVersion: appPackage.version,
    nodeVersion: version.stdout.trim(),
    hashes: {
      appExe: hash(appExe),
      appAsar: hash(asarFile),
      helper: hash(packagedHelper),
      node: hash(packagedNode),
      generatedClient: clientHash,
    },
    callers,
    refreshed,
    cleanup: { authenticatedNativeEmpty: true, disposableRootRemoved: true },
  }
} finally {
  const cleanup = await Promise.allSettled([...records].map(stop))
  const failures = cleanup.filter((item) => item.status === 'rejected')
  if (failures.length)
    throw new AggregateError(
      failures.map((item) => item.reason),
      'Packaged CLI ownership cleanup failed; workspace retained',
    )
  rmSync(root, { recursive: true })
  assert(!existsSync(root), 'Disposable app workspace remains')
}
assert(result, 'Packaged CLI acceptance did not complete')
mkdirSync(path.dirname(path.resolve(receiptArg)), { recursive: true })
writeFileSync(path.resolve(receiptArg), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log('Packaged Windows CLI acceptance and authenticated cleanup passed')
