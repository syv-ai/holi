import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? '/tmp/holi-502/native')
const typst = process.env.HOLI_502_TYPST ?? process.argv[3]
assert(typst, 'Provide a Typst executable as argument 3 or HOLI_502_TYPST')
await access(typst)
const root = await mkdtemp(join(tmpdir(), 'holi-502-native-'))
await mkdir(evidence, { recursive: true })
await rm(join(evidence, 'frames'), { recursive: true, force: true })
for (const name of ['result.json', 'electron-smoke.log', 'light.png', 'dark.png'])
  await rm(join(evidence, name), { force: true })
let child
let closed
let log = ''
try {
  await build({
    configFile: false,
    root: desktop,
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    build: {
      outDir: join(root, 'renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: join(desktop, 'scripts/code-captions-smoke-renderer.tsx'),
        output: { entryFileNames: 'renderer.js', assetFileNames: 'renderer.[ext]' },
      },
    },
  })
  await build({
    configFile: false,
    root: desktop,
    build: {
      ssr: true,
      target: 'node24',
      outDir: root,
      emptyOutDir: false,
      rollupOptions: {
        input: join(desktop, 'scripts/code-captions-smoke-main.ts'),
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
    join(root, 'renderer.html'),
    '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;self&#39;; style-src &#39;self&#39; &#39;unsafe-inline&#39;; img-src data:; font-src &#39;self&#39;; connect-src &#39;none&#39;"><title>Holi code captions native acceptance</title><link rel="stylesheet" href="renderer/renderer.css"></head><body><div id="root"></div><script type="module" src="renderer/renderer.js"></script></body></html>',
  )
  await writeFile(
    join(root, 'preload.cjs'),
    `const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('holi', { platform: process.platform, trpc: (op) => ipcRenderer.invoke('holi-caption-fixture', op) });`,
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-code-captions-smoke-502', main: 'main.cjs' }),
  )
  await cp(
    join(desktop, 'src/plugins/pdf/main/vault/once/.holi/document-templates/plain'),
    join(root, 'vault/.holi/document-templates/plain'),
    { recursive: true },
  )
  const electron = createRequire(import.meta.url)('electron')
  const env = {
    ...process.env,
    HOLI_502_ROOT: root,
    HOLI_502_EVIDENCE: evidence,
    HOLI_502_TYPST: resolve(typst),
    HOLI_502_DESKTOP: desktop,
    HOLI_VAULT_ROOT: join(root, 'vault'),
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
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
  closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  let timeout
  const code = await Promise.race([
    closed,
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        child.kill()
        reject(new Error('Electron smoke timed out'))
      }, 180_000)
    }),
  ]).finally(() => clearTimeout(timeout))
  assert.equal(code, 0, 'native code caption acceptance failed')
  assert(!log.includes('Error occurred in handler'), 'native IPC handler failed')
  const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'))
  assert.equal(result.ok, true)
  assert.equal(result.electron.split('.')[0], '43')
  assert(result.checks.length >= 14, 'missing native acceptance assertions')
  for (const capture of result.captures) assert((await stat(join(evidence, capture))).size > 0)
  assert.deepEqual(result.rendererErrors, [])
  assert.deepEqual(result.denied, [])
  for (const file of ['native-ui.pdf', 'native-cli.pdf', 'pdf-proof.json'])
    assert((await stat(join(evidence, file))).size > 0)
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    const exited = await Promise.race([
      closed.then(
        () => true,
        () => true,
      ),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ])
    if (!exited) {
      child.kill('SIGKILL')
      await closed.catch(() => {})
    }
  }
  try {
    await writeFile(join(evidence, 'electron-smoke.log'), log)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
