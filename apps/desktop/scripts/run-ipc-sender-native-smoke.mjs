import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { externalizeDepsPlugin } from 'electron-vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = await mkdtemp(join(tmpdir(), 'holi-506-smoke-'))
const evidence = resolve(process.argv[2] ?? join(tmpdir(), 'holi-506-evidence'))
await mkdir(evidence, { recursive: true })
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<!doctype html><html><body>isolated IPC smoke fixture</body></html>')
})
const crossServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<!doctype html><html><body>cross-origin fixture</body></html>')
})
let child
let closed
let timer
let log = ''
try {
  await new Promise((resolve, reject) =>
    server.listen(0, '127.0.0.1', (error) => (error ? reject(error) : resolve())),
  )
  await new Promise((resolve, reject) =>
    crossServer.listen(0, '127.0.0.1', (error) => (error ? reject(error) : resolve())),
  )
  const address = server.address()
  const crossAddress = crossServer.address()
  assert(address && typeof address === 'object')
  assert(crossAddress && typeof crossAddress === 'object')
  const entry = `http://127.0.0.1:${address.port}/`
  const crossEntry = `http://127.0.0.1:${crossAddress.port}/`
  const output = join(root, 'bundle')
  await build({
    configFile: false,
    root: desktop,
    plugins: [externalizeDepsPlugin({ exclude: ['@holi/shared'] })],
    build: {
      ssr: true,
      target: 'node24',
      outDir: output,
      emptyOutDir: true,
      rollupOptions: {
        input: join(desktop, 'scripts/ipc-sender-native-smoke.ts'),
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'main.cjs',
          banner: `module.paths.unshift(${JSON.stringify(join(desktop, 'node_modules'))});`,
        },
      },
    },
  })
  await writeFile(
    join(output, 'package.json'),
    JSON.stringify({ name: 'holi-506-native-smoke', main: 'main.cjs' }),
  )
  const electron = createRequire(import.meta.url)('electron')
  const home = join(root, 'home')
  await Promise.all(
    [home, join(root, 'user-data'), join(root, 'session-data')].map((path) => mkdir(path)),
  )
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
    HOLI_506_ROOT: root,
    HOLI_506_EVIDENCE: evidence,
    HOLI_506_ENTRY: entry,
    HOLI_506_CROSS_ENTRY: crossEntry,
  }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [output], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => {
    log += chunk
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    log += chunk
    process.stderr.write(chunk)
  })
  closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const code = await Promise.race([
    closed,
    new Promise(
      (_, reject) =>
        (timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('native smoke timed out'))
        }, 60_000)),
    ),
  ])
  assert.equal(code, 0, 'Electron native sender smoke failed')
  const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert(result.scenarios >= 30)
  console.log(`native IPC sender smoke: ${result.scenarios} scenarios passed (${result.electron})`)
} finally {
  clearTimeout(timer)
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await closed.catch(() => {})
  }
  server.closeAllConnections()
  crossServer.closeAllConnections()
  await Promise.all(
    [server, crossServer].map((value) => new Promise((resolve) => value.close(resolve))),
  )
  await writeFile(join(evidence, 'electron-smoke.log'), log)
  await rm(root, { recursive: true, force: true })
}
