import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'vite'
import { createOwnedProcesses } from './owned-processes.mjs'
import { startOwnedPty } from '../../../scripts/pi-native-tui-process.mjs'

if (process.platform !== 'darwin' || !process.argv[2])
  throw new Error(
    'Usage: run-claude-native-background.mjs <native-claude-bin> [new-evidence-dir]; requires macOS',
  )
const executable = await realpath(process.argv[2])
const evidenceDir = process.argv[3]
  ? resolve(process.argv[3])
  : await mkdtemp(join(tmpdir(), 'holi-claude-evidence-'))
if (process.argv[3]) await mkdir(evidenceDir, { mode: 0o700 })
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = await realpath(await mkdtemp('/tmp/holi-claude-background-'))
const home = join(root, 'home')
const cwd = join(root, 'vault')
const configDir = join(home, '.claude')
const controller = new AbortController()
const interrupt = () => controller.abort(new Error('native Claude fixture interrupted'))
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
const watchdog = setTimeout(
  () => controller.abort(new Error('native Claude fixture deadline exceeded')),
  60_000,
)
const processes = createOwnedProcesses({ signal: controller.signal })
const cleanupProcesses = createOwnedProcesses()
const evidence = {
  scope: 'native background control',
  modelTurn: 'unverified',
  notificationDelivery: 'unverified',
  requests: [],
  cleanup: {},
}
let namespace
let server
let env
let profile
let failure
let daemonMayExist = false
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const plain = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ' ')
const compact = (text) => plain(text).replace(/\s/g, '')
const pause = (ms) => delay(ms, undefined, { signal: controller.signal })
const capture = async (name, operation) => {
  try {
    evidence.cleanup[name] = { ok: true, result: await operation() }
  } catch (error) {
    evidence.cleanup[name] = { ok: false, error: String(error) }
  }
}
try {
  evidence.binary = executable
  evidence.sha256 = createHash('sha256')
    .update(await readFile(executable))
    .digest('hex')
  await Promise.all([mkdir(home), mkdir(cwd), mkdir(join(root, 'tmp'))])
  const parent = `/private/tmp/cc-daemon-${process.getuid()}`
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const parentInfo = await lstat(parent)
  if (!parentInfo.isDirectory() || parentInfo.uid !== process.getuid() || parentInfo.mode & 0o022)
    throw new Error('Native daemon parent is not privately owned')
  const candidate = join(parent, createHash('sha256').update(configDir).digest('hex').slice(0, 8))
  await mkdir(candidate, { mode: 0o700 })
  namespace = candidate
  server = createServer((request, response) => {
    if (evidence.requests.length < 32)
      evidence.requests.push({
        method: request.method,
        path: new URL(request.url, 'http://127.0.0.1').pathname,
        status: 404,
      })
    response.writeHead(404).end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  profile = `(version 1) (allow default) (deny network*) (allow network-outbound (remote tcp "localhost:${port}")) (allow network-inbound (local tcp "localhost:${port}")) (allow system-socket (socket-domain AF_UNIX)) (allow network-bind (local unix-socket (subpath "${root}"))) (allow network-outbound (remote unix-socket (subpath "${root}"))) (allow network-bind (local unix-socket (subpath "${namespace}"))) (allow network-outbound (remote unix-socket (subpath "${namespace}")))`
  env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: join(root, 'tmp'),
    CLAUDE_CODE_TMPDIR: join(root, 'tmp'),
    CLAUDE_TMPDIR: join(root, 'tmp'),
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: 'sk-ant-loopback-only',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_API_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_BEDROCK_BASE_URL: `http://127.0.0.1:${port}`,
    AWS_REGION: 'us-east-1',
    AWS_BEARER_TOKEN_BEDROCK: 'owned-fixture-token',
    AWS_EC2_METADATA_DISABLED: 'true',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    NO_COLOR: '1',
  }
  const invoke = (args) =>
    processes.run('/usr/bin/sandbox-exec', ['-p', profile, executable, ...args], {
      cwd,
      env,
      timeoutMs: 20_000,
    })
  evidence.version = (await invoke(['--version'])).output
  const wrapper = join(root, 'claude-contained')
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec /usr/bin/sandbox-exec -p ${quote(profile)} ${quote(executable)} "$@"\n`,
    { mode: 0o700 },
  )
  daemonMayExist = true
  const tui = await startOwnedPty({
    command: '/usr/bin/sandbox-exec',
    args: ['-p', profile, executable],
    cwd,
    env: { ...env, TERM: 'xterm-256color' },
    stateDirectory: join(root, 'trust-pty'),
    timeoutMs: 12_000,
  })
  try {
    await pause(1800)
    const initial = tui.output.toString()
    if (!/Choose\s+the\s+text\s+style/.test(plain(initial)))
      throw new Error('Native theme selector not observed')
    await tui.write('\r')
    await pause(600)
    if (
      !tui.output
        .toString()
        .slice(initial.length)
        .includes('https://code.claude.com/docs/en/security')
    )
      throw new Error('Native security notes not observed')
    const beforeTrust = tui.output.length
    await tui.write('\r')
    await pause(600)
    const trust = compact(tui.output.toString().slice(beforeTrust))
    if (!trust.includes(compact(cwd)) || !trust.includes('Yes,Itrustthisfolder'))
      throw new Error('Owned native workspace consent not observed')
    await tui.write('\x1b[B')
    await pause(150)
    await tui.write('\r')
    await pause(800)
  } finally {
    const transcript = tui.output.toString()
    await capture('pty', () => tui.close())
    await writeFile(join(evidenceDir, 'native-trust.txt'), transcript)
    if (!evidence.cleanup.pty.ok) throw new Error('Native PTY drainage was not confirmed')
  }
  controller.signal.throwIfAborted()
  await build({
    configFile: false,
    root: desktop,
    logLevel: 'error',
    build: {
      ssr: join(desktop, 'scripts/claude-native-background-worker.ts'),
      outDir: join(root, 'bundle'),
      emptyOutDir: false,
      minify: false,
      rollupOptions: { output: { format: 'es', entryFileNames: 'worker.mjs' } },
    },
    ssr: { noExternal: ['@holi/shared'] },
  })
  await symlink(join(desktop, 'node_modules'), join(root, 'node_modules'), 'dir')
  const workerResult = join(root, 'worker-result.json')
  await processes.run(process.execPath, [join(root, 'bundle/worker.mjs')], {
    cwd,
    env: { ...env, HOLI_NATIVE_WRAPPER: wrapper, HOLI_NATIVE_WORKER_RESULT: workerResult },
    timeoutMs: 30_000,
  })
  evidence.lifecycle = JSON.parse(await readFile(workerResult, 'utf8'))
} catch (error) {
  failure = error
  evidence.error = String(error)
} finally {
  clearTimeout(watchdog)
  if (daemonMayExist)
    await capture(
      'daemon',
      async () =>
        (
          await cleanupProcesses.run(
            '/usr/bin/sandbox-exec',
            ['-p', profile, executable, 'daemon', 'stop', '--any'],
            { cwd, env, timeoutMs: 20_000 },
          )
        ).output,
    )
  await capture('processes', () => processes.stopAll(500, 1500))
  await capture('cleanupProcesses', () => cleanupProcesses.stopAll(500, 1500))
  if (server)
    await capture('server', async () => {
      server.closeAllConnections()
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    })
  if (Object.values(evidence.cleanup).every((step) => step.ok)) {
    if (namespace) await capture('namespace', () => rm(namespace, { recursive: true, force: true }))
    await capture('runtime', () => rm(root, { recursive: true, force: true }))
  } else evidence.retainedRuntime = root
  await writeFile(join(evidenceDir, 'result.json'), JSON.stringify(evidence, null, 2))
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}
if (failure || Object.values(evidence.cleanup).some((step) => !step.ok))
  throw new Error(`Native background control failed; evidence: ${evidenceDir}`, { cause: failure })
console.log(`Native background control recorded: ${evidenceDir}`)
