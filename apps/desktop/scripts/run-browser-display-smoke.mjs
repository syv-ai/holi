import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { externalizeDepsPlugin } from 'electron-vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? join(tmpdir(), 'holi-472-evidence'))
const root = await mkdtemp(join(tmpdir(), 'holi-472-smoke-'))
await mkdir(evidence, { recursive: true })
let child
let closed
let log = ''
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
        input: join(desktop, 'scripts/browser-display-smoke.ts'),
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
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-browser-display-qa-472', main: 'main.cjs' }),
  )
  const electron = createRequire(import.meta.url)('electron')
  const env = {
    ...process.env,
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
    HOLI_472_ROOT: root,
    HOLI_472_EVIDENCE: evidence,
  }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [root], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => {
    log += chunk
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    log += chunk
    process.stderr.write(chunk)
  })
  let timeout
  let code
  closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  try {
    code = await Promise.race([
      closed,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          child.kill()
          reject(new Error('Electron smoke timed out'))
        }, 60_000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
  assert.equal(code, 0, 'native Electron browser display smoke failed')
  const { readFile, stat } = await import('node:fs/promises')
  const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'))
  assert.equal(result.ok, true)
  for (const check of [
    'displayed-page-attached',
    'departure-detaches-synchronously',
    'hidden-read-placement-and-reveal-do-not-act-on-display',
    'new-owner-attaches',
    'return-requires-fresh-owner-placement',
  ])
    assert(result.checks.includes(check), `missing native check: ${check}`)
  for (const name of result.screenshots)
    assert((await stat(join(evidence, name))).size > 0, `missing screenshot: ${name}`)
} finally {
  if (child && child.exitCode === null) {
    child.kill()
    await Promise.race([
      closed.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])
  }
  await writeFile(join(evidence, 'electron-smoke.log'), log)
  await rm(root, { recursive: true, force: true })
}
