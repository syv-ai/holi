import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { externalizeDepsPlugin } from 'electron-vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? join(tmpdir(), 'holi-372-evidence'))
const root = await realpath(await mkdtemp(join(tmpdir(), 'holi-372-smoke-')))
await mkdir(evidence, { recursive: true })
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
  const electron = createRequire(import.meta.url)('electron')
  const env = {
    ...process.env,
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
    HOLI_QA372_ROOT: root,
    HOLI_QA372_DESKTOP: desktop,
    HOLI_QA372_EVIDENCE: evidence,
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [root], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let log = ''
  child.stdout.on('data', (data) => {
    log += data
    process.stdout.write(data)
  })
  child.stderr.on('data', (data) => {
    log += data
    process.stderr.write(data)
  })
  const timer = setTimeout(() => child.kill(), 180_000)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    assert.equal(code, 0, 'Disposable native Electron smoke failed')
  } finally {
    clearTimeout(timer)
    await writeFile(join(evidence, 'electron-smoke.log'), log)
  }
} finally {
  await rm(root, { recursive: true, force: true })
  console.log('Disposable app, profile and vault removed')
}
