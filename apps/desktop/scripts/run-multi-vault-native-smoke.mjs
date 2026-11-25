import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { observeChild } from './native-smoke-process.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? '/tmp/holi-176-native')
await assert.rejects(access(evidence), { code: 'ENOENT' })
const electron = createRequire(import.meta.url)('electron')
await access(electron)
await mkdir(evidence, { mode: 0o700 })
const root = await mkdtemp(join(tmpdir(), 'holi-176-native-'))
let child
let state
let log = ''
let timer
try {
  await build({
    configFile: false,
    root: desktop,
    base: './',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    build: {
      outDir: join(root, 'renderer'),
      rollupOptions: {
        input: join(desktop, 'scripts/multi-vault-smoke-renderer.tsx'),
        output: { entryFileNames: 'renderer.js', assetFileNames: 'renderer.[ext]' },
      },
    },
  })
  for (const [input, output] of [
    ['scripts/multi-vault-smoke-main.ts', 'main.cjs'],
    ['src/preload/index.ts', 'preload.cjs'],
  ]) {
    await build({
      configFile: false,
      root: desktop,
      build: {
        ssr: true,
        target: 'node24',
        outDir: root,
        emptyOutDir: false,
        rollupOptions: {
          input: join(desktop, input),
          external: ['electron'],
          output: {
            format: 'cjs',
            entryFileNames: output,
            banner:
              output === 'main.cjs'
                ? `module.paths.unshift(${JSON.stringify(join(desktop, 'node_modules'))});`
                : '',
          },
        },
      },
    })
  }
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-176-native-fixture', main: 'main.cjs' }),
  )
  await writeFile(
    join(root, 'renderer.html'),
    '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src \'self\'; img-src data:;"><link rel="stylesheet" href="renderer/renderer.css"><title>Holi multi-vault native fixture</title></head><body><div id="root"></div><script type="module" src="renderer/renderer.js"></script></body></html>',
  )
  await writeFile(
    join(root, 'gitconfig'),
    '[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n',
  )
  const env = {
    ...process.env,
    HOLI_176_ROOT: root,
    HOLI_176_EVIDENCE: evidence,
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [root], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  state = observeChild(child)
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      log += chunk
      process.stdout.write(chunk)
    })
  const result = await Promise.race([
    state.closed,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native fixture exceeded 180 seconds')), 180_000)
    }),
  ])
  clearTimeout(timer)
  assert.equal(result.code, 0, JSON.stringify(result))
  const evidenceResult = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'))
  assert.equal(evidenceResult.ok, true)
  assert.deepEqual(evidenceResult.cleanupErrors, [])
  await access(join(evidence, 'two-vaults.png'))
} finally {
  clearTimeout(timer)
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    let killTimer
    await Promise.race([
      state.closed,
      new Promise((resolve) => {
        killTimer = setTimeout(resolve, 5000)
      }),
    ])
    clearTimeout(killTimer)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await state.closed
    }
  }
  await writeFile(join(evidence, 'electron.log'), log)
  await rm(root, { recursive: true, force: true })
  await writeFile(
    join(evidence, 'owned-cleanup.json'),
    JSON.stringify(
      {
        processClosed: !child || child.exitCode !== null || child.signalCode !== null,
        profileAndClonesRemoved: true,
      },
      null,
      2,
    ),
  )
}
