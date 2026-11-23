import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const binArg = args[0]
const evidence = resolve(args[1] ?? join(tmpdir(), `holi-native-background-${Date.now()}`))
if (!binArg)
  throw new Error(
    'Usage: node scripts/run-claude-native-background.mjs <claude-bin> [evidence-dir]',
  )
if (process.platform !== 'darwin') throw new Error('This native lifecycle probe requires macOS')
const bin = await realpath(binArg)
await mkdir(evidence, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'holi-native-background-'))
const home = join(root, 'home')
const cwd = join(root, 'vault')
const configDir = join(home, '.claude')
const bundle = join(root, 'worker.mjs')
const resultFile = join(evidence, 'result.json')
const logFile = join(evidence, 'runner.log')
let failure
let namespace
try {
  await Promise.all([mkdir(home), mkdir(cwd), mkdir(configDir)])
  namespace = join(
    '/private/tmp',
    `cc-daemon-${process.getuid()}`,
    createHash('sha256').update(configDir).digest('hex').slice(0, 8),
  )
  try {
    await mkdir(namespace, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error(`Refusing to use existing native namespace: ${namespace}`)
  }
  await build({
    configFile: false,
    root: desktop,
    build: {
      ssr: join(desktop, 'scripts/claude-native-background-worker.ts'),
      outDir: root,
      emptyOutDir: false,
      minify: false,
      rollupOptions: { output: { format: 'es', entryFileNames: 'worker.mjs' } },
    },
    ssr: { noExternal: ['@holi/shared'] },
  })
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: configDir }
  const child = spawn(process.execPath, [bundle, bin, cwd, configDir, resultFile], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      log = (log + chunk).slice(-100_000)
    })
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  await writeFile(logFile, log)
  if (status.code !== 0) failure = `Worker exited ${JSON.stringify(status)}`
} catch (error) {
  failure = String(error)
} finally {
  const cleanup = []
  if (namespace) {
    try {
      const daemon = spawn(bin, ['daemon', 'stop', '--any'], {
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: configDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      for (const stream of [daemon.stdout, daemon.stderr])
        stream.on('data', (chunk) => {
          output = (output + chunk).slice(-8000)
        })
      const result = await new Promise((resolve) =>
        daemon.once('close', (code) => resolve({ code })),
      )
      cleanup.push({ daemonStop: result, output })
    } catch (error) {
      cleanup.push({ daemonStopError: String(error) })
    }
    try {
      await rm(namespace, { recursive: true, force: true })
      cleanup.push({ namespaceRemoved: true })
    } catch (error) {
      cleanup.push({ namespaceError: String(error) })
    }
  }
  try {
    await rm(root, { recursive: true, force: true })
    cleanup.push({ rootRemoved: true })
  } catch (error) {
    cleanup.push({ rootError: String(error) })
  }
  await writeFile(join(evidence, 'cleanup.json'), JSON.stringify(cleanup, null, 2))
}
if (failure) throw new Error(failure)
console.log(`Lifecycle evidence: ${evidence}`)
