import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'

assert.equal(process.platform, 'darwin', 'native clipboard smoke requires macOS')

const clipboardJxa = String.raw`
ObjC.import('AppKit')
ObjC.import('Foundation')
const pb = $.NSPasteboard.generalPasteboard
function dataMap() {
  const items = []
  const all = pb.pasteboardItems
  for (let i = 0; i < all.count; i++) {
    const item = all.objectAtIndex(i)
    const itemTypes = item.types
    const types = []
    for (let j = 0; j < itemTypes.count; j++) types.push(ObjC.unwrap(itemTypes.objectAtIndex(j)))
    types.sort()
    const data = {}
    for (const type of types) {
      const bytes = item.dataForType($(type))
      if (!bytes || String(bytes) === 'null') throw new Error('clipboard format data unavailable')
      data[type] = ObjC.unwrap(bytes.base64EncodedStringWithOptions(0))
    }
    items.push({ types, data })
  }
  return items
}
function restore(items) {
  const rebuilt = items.map((entry) => {
    const item = $.NSPasteboardItem.alloc.init
    for (const type of entry.types) {
      if (entry.data[type] === null) continue
      const bytes = $.NSData.alloc.initWithBase64EncodedStringOptions($(entry.data[type]), 0)
      if (!bytes || String(bytes) === 'null' || !item.setDataForType(bytes, $(type))) throw new Error('could not rebuild clipboard data')
    }
    return item
  })
  pb.clearContents
  if (rebuilt.length && !pb.writeObjects(ObjC.wrap(rebuilt))) throw new Error('clipboard write failed')
  const actual = dataMap()
  if (JSON.stringify(actual) !== JSON.stringify(items)) throw new Error('clipboard verification mismatch')
  return { ok: true, items: actual.length, types: actual.reduce((n, item) => n + item.types.length, 0) }
}
function run(argv) {
  const action = argv[0]
  if (action === 'snapshot') return JSON.stringify(dataMap())
  if (action === 'restore') return JSON.stringify(restore(JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError($(argv[1]), $.NSUTF8StringEncoding, null)))))
  if (action === 'self-test') {
    const originalText = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError($(argv[1]), $.NSUTF8StringEncoding, null))
    const original = JSON.parse(originalText)
    let passed = false
    try {
      const first = $.NSPasteboardItem.alloc.init
      first.setDataForType($.NSString.alloc.initWithUTF8String('opaque-custom').dataUsingEncoding($.NSUTF8StringEncoding), $('com.holi.smoke.opaque'))
      first.setDataForType($.NSString.alloc.initWithUTF8String('<b>fixture</b>').dataUsingEncoding($.NSUTF8StringEncoding), $('public.html'))
      const second = $.NSPasteboardItem.alloc.init
      second.setDataForType($.NSString.alloc.initWithUTF8String('two items').dataUsingEncoding($.NSUTF8StringEncoding), $('public.utf8-plain-text'))
      pb.clearContents
      if (!pb.writeObjects(ObjC.wrap([first, second]))) throw new Error('self-test fixture write failed')
      const expected = dataMap()
      if (expected.length !== 2 || expected[0].types.length !== 2 || expected[1].types.length !== 1) throw new Error('self-test fixture shape mismatch')
      restore(expected)
      passed = true
    } finally {
      restore(original)
    }
    return JSON.stringify({ ok: passed, items: 2, types: 3 })
  }
  throw new Error('unknown clipboard action')
}
`

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? '/tmp/holi-502/native')
const typst = process.env.HOLI_502_TYPST ?? process.argv[3]
assert(typst, 'Provide a Typst executable as argument 3 or HOLI_502_TYPST')
await access(typst)
const root = await mkdtemp(join(tmpdir(), 'holi-502-native-'))
await chmod(root, 0o700)
const clipboardBackup = join(root, 'clipboard-snapshot.json')
const clipboardScript = join(root, 'clipboard.jxa')
await writeFile(clipboardScript, clipboardJxa, { mode: 0o600 })
await mkdir(evidence, { recursive: true })
await rm(join(evidence, 'frames'), { recursive: true, force: true })
for (const name of [
  'result.json',
  'electron-smoke.log',
  'light.png',
  'dark.png',
  'mermaid-light.png',
  'mermaid-dark.png',
  'native-ui.pdf',
  'native-cli.pdf',
  'pdf-proof.json',
  'mermaid-ui-valid.pdf',
  'mermaid-cli-valid.pdf',
  'mermaid-ui-fallback.pdf',
  'mermaid-cli-fallback.pdf',
  'mermaid-pdf-proof.json',
  'failure.png',
  'interaction.mp4',
  'ffmpeg.log',
])
  await rm(join(evidence, name), { force: true })
let child
let closed
let log = ''
let clipboardRestored = false
let clipboardSelfTest
try {
  const originalClipboard = clipboardCommand('snapshot')
  await writeFile(clipboardBackup, originalClipboard, { mode: 0o600 })
  clipboardSelfTest = JSON.parse(clipboardCommand('self-test', clipboardBackup))
  assert.equal(clipboardSelfTest.ok, true)

  await build({
    configFile: false,
    root: desktop,
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    base: './',
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
    JSON.stringify({ name: 'holi-code-captions-smoke-503', main: 'main.cjs' }),
  )
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await symlink(join(desktop, 'node_modules/mermaid'), join(root, 'node_modules/mermaid'))
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
  const recording = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-framerate',
      '2',
      '-i',
      join(evidence, 'frames/frame-%04d.png'),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      join(evidence, 'interaction.mp4'),
    ],
    { encoding: 'utf8' },
  )
  await writeFile(join(evidence, 'ffmpeg.log'), recording.stderr ?? '')
  assert.equal(recording.status, 0, 'interactive Electron recording must encode')
  assert((await stat(join(evidence, 'interaction.mp4'))).size > 0)
  for (const file of [
    'native-ui.pdf',
    'native-cli.pdf',
    'pdf-proof.json',
    'mermaid-ui-valid.pdf',
    'mermaid-cli-valid.pdf',
    'mermaid-ui-fallback.pdf',
    'mermaid-cli-fallback.pdf',
    'mermaid-pdf-proof.json',
  ])
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
    const hasClipboardBackup = await access(clipboardBackup).then(
      () => true,
      () => false,
    )
    if (hasClipboardBackup) {
      try {
        const restore = JSON.parse(clipboardCommand('restore', clipboardBackup))
        clipboardRestored = restore.ok
        assert.equal(clipboardRestored, true, 'clipboard restoration did not verify')
        await writeFile(
          join(evidence, 'clipboard-proof.json'),
          JSON.stringify({ restored: true, ...clipboardSelfTest }, null, 2),
        )
        const resultPath = join(evidence, 'result.json')
        if (
          await access(resultPath).then(
            () => true,
            () => false,
          )
        ) {
          const result = JSON.parse(await readFile(resultPath, 'utf8'))
          result.clipboardRestored = true
          result.clipboardSelfTest = {
            ok: true,
            items: clipboardSelfTest.items,
            types: clipboardSelfTest.types,
          }
          await writeFile(resultPath, JSON.stringify(result, null, 2))
        }
      } catch (error) {
        const resultPath = join(evidence, 'result.json')
        const result = await readFile(resultPath, 'utf8')
          .then(JSON.parse)
          .catch(() => null)
        if (result) {
          result.ok = false
          result.clipboardRestored = false
          await writeFile(resultPath, JSON.stringify(result, null, 2))
        }
        console.error(
          `Clipboard restoration failed; private backup preserved at ${clipboardBackup}`,
        )
        throw error
      }
    }
    if (clipboardRestored || !hasClipboardBackup) await rm(root, { recursive: true, force: true })
    else console.error(`Private clipboard backup preserved at ${clipboardBackup}`)
  }
}

function clipboardCommand(action, backup = '') {
  const result = spawnSync('osascript', ['-l', 'JavaScript', clipboardScript, action, backup], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
  })
  assert.equal(result.status, 0, `osascript ${action} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}
