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
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: desktop, encoding: 'utf8' })
assert.equal(revision.status, 0, 'source revision must be available')
const sourceHead = revision.stdout.trim()
const status = spawnSync('git', ['status', '--porcelain'], { cwd: desktop, encoding: 'utf8' })
assert.equal(status.status, 0, 'source working-tree status must be available')
const sourceDirty = status.stdout.length > 0
const args = process.argv.slice(2)
const tablesOnly = args.includes('--tables-only')
const positional = args.filter((arg) => arg !== '--tables-only')
const scope = tablesOnly ? 'tables-only' : 'full'
const evidence = resolve(positional[0] ?? '/tmp/holi-535/native')
const typst = process.env.HOLI_535_TYPST ?? positional[1]
if (!tablesOnly) {
  assert(typst, 'Provide a Typst executable as argument 3 or HOLI_535_TYPST')
  await access(typst)
}
const tableChecks = [
  'native-table-toolbar-add-caption-save-reopen-frontmatter-light-dark',
  'native-table-row-column-caption-edit-external-reload-and-remove',
  'native-matching-tables-caption-controls-follow-current-selection',
  'native-table-formatted-caption-complete-save-and-reopen',
  'native-table-duplicate-move-and-undo-preserve-association',
  'native-table-confirmed-delete-and-undo-save-reopen',
  'native-table-caption-find-and-file-comment-anchors',
  'native-table-split-and-retained-view-ownership',
  'native-table-locked-view-rejects-native-mutation',
  'native-table-plain-markdown-edit-save-and-rich-reopen',
  'native-table-banded-selection-resize-scroll-and-reopen',
  'native-table-lines-selection-resize-scroll-and-reopen',
]
await assert.rejects(access(evidence), {
  code: 'ENOENT',
})
await mkdir(evidence, { mode: 0o700 })
const root = await mkdtemp(join(tmpdir(), 'holi-535-native-'))
await chmod(root, 0o700)
const clipboardBackup = join(root, 'clipboard-snapshot.json')
const clipboardScript = join(root, 'clipboard.jxa')
await writeFile(clipboardScript, clipboardJxa, { mode: 0o600 })
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
    '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;self&#39;; style-src &#39;self&#39; &#39;unsafe-inline&#39;; img-src data: holi-vault:; font-src &#39;self&#39;; connect-src &#39;none&#39;"><title>Holi code captions native acceptance</title><link rel="stylesheet" href="renderer/renderer.css"></head><body><div id="root"></div><script type="module" src="renderer/renderer.js"></script></body></html>',
  )
  await writeFile(
    join(root, 'preload.cjs'),
    `const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('holi', { platform: process.platform, trpc: (op) => ipcRenderer.invoke('holi-caption-fixture', op) });`,
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-image-captions-smoke-535', main: 'main.cjs' }),
  )
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await symlink(join(desktop, 'node_modules/mermaid'), join(root, 'node_modules/mermaid'))
  if (!tablesOnly)
    await cp(
      join(desktop, 'src/plugins/pdf/main/vault/once/.holi/document-templates/plain'),
      join(root, 'vault/.holi/document-templates/plain'),
      { recursive: true },
    )
  const electron = createRequire(import.meta.url)('electron')
  const env = {
    ...process.env,
    HOLI_535_ROOT: root,
    HOLI_535_EVIDENCE: evidence,
    HOLI_535_TYPST: tablesOnly ? '' : resolve(typst),
    HOLI_535_SCOPE: scope,
    HOLI_535_SOURCE_HEAD: sourceHead,
    HOLI_535_SOURCE_DIRTY: String(sourceDirty),
    HOLI_535_DESKTOP: desktop,
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
      }, 300_000)
    }),
  ]).finally(() => clearTimeout(timeout))
  assert.equal(code, 0, 'native code caption acceptance failed')
  assert(!log.includes('Error occurred in handler'), 'native IPC handler failed')
  const frames = join(evidence, 'frames', 'frame-%04d.png')
  const video = join(evidence, 'native-interaction.mp4')
  const encode = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-framerate',
      '5',
      '-i',
      frames,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      video,
    ],
    { encoding: 'utf8', timeout: 120000 },
  )
  assert.equal(encode.status, 0, `interaction video encoding failed: ${encode.stderr}`)
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_name,nb_frames',
      '-of',
      'json',
      video,
    ],
    { encoding: 'utf8', timeout: 30000 },
  )
  assert.equal(probe.status, 0, `interaction video probe failed: ${probe.stderr}`)
  const videoInfo = JSON.parse(probe.stdout)
  assert.equal(videoInfo.streams?.[0]?.codec_name, 'h264')
  assert(
    Number(videoInfo.format?.duration) >= (tablesOnly ? 0.2 : 10),
    `interaction video must show the ${scope} native flow`,
  )
  await writeFile(join(evidence, 'video-proof.json'), JSON.stringify(videoInfo, null, 2))
  const result = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'))
  assert.equal(result.ok, true)
  assert.equal(result.scope, scope)
  assert.deepEqual(result.source, { head: sourceHead, dirty: sourceDirty })
  for (const name of tableChecks)
    assert(result.checks.includes(name), `missing native table acceptance: ${name}`)
  if (tablesOnly)
    assert.deepEqual(
      [...result.checks].sort(),
      ['production-document-view-with-real-router-filesystem', ...tableChecks].sort(),
    )
  assert.equal(result.electron.split('.')[0], '43')
  if (!tablesOnly) {
    assert(result.checks.length >= 47, 'missing native acceptance assertions')
    for (const name of [
      'native-same-alt-and-protected-examples-survive-unrelated-save-reopen',
      'native-image-copy-os-clipboard-plain-markdown-save-reopen',
      'native-image-cut-os-clipboard-plain-markdown-save-reopen',
      'native-documentFigure-copy-os-clipboard-plain-markdown-save-reopen',
      'native-documentFigure-cut-os-clipboard-plain-markdown-save-reopen',
      'native-root-to-nested-copy-paste-save-reopen-real-typst-pdf',
      'native-root-to-root-copy-paste-save-reopen-real-typst-pdf',
      'native-nested-to-root-copy-paste-save-reopen-real-typst-pdf',
      'native-spaced-image-path-copy-paste-save-reopen-real-typst-pdf',
    ])
      assert(result.checks.includes(name), `missing native acceptance: ${name}`)
  }
  for (const capture of result.captures) assert((await stat(join(evidence, capture))).size > 0)
  assert.deepEqual(result.rendererErrors, [])
  assert.deepEqual(result.denied, [])
  const requiredFiles = tablesOnly
    ? [
        'table-caption-light.png',
        'table-caption-dark.png',
        'table-caption-saved.json',
        'table-caption-actions.png',
        'table-caption-formatted-light.png',
        'table-caption-formatted-dark.png',
        'table-actions-saved.md.txt',
        'table-caption-find.png',
        'table-caption-split.png',
        'table-caption-locked.png',
        'table-caption-markdown.png',
        'table-markdown-saved.md.txt',
        'table-caption-banded.png',
        'table-caption-lines.png',
      ]
    : [
        'native-ui.pdf',
        'native-cli.pdf',
        'pdf-proof.json',
        'root-to-nested.pdf',
        'root-to-root.pdf',
        'nested-to-root.pdf',
        'plain-image-copy-clipboard.json',
        'plain-image-cut-clipboard.json',
        'plain-documentFigure-copy-clipboard.json',
        'plain-documentFigure-cut-clipboard.json',
        'mermaid-ui-valid.pdf',
        'mermaid-cli-valid.pdf',
        'mermaid-ui-fallback.pdf',
        'mermaid-cli-fallback.pdf',
        'mermaid-pdf-proof.json',
      ]
  for (const file of requiredFiles) assert((await stat(join(evidence, file))).size > 0)
} catch (error) {
  const resultPath = join(evidence, 'result.json')
  const result = await readFile(resultPath, 'utf8')
    .then(JSON.parse)
    .catch(() => ({ scope, checks: [], captures: [] }))
  result.ok = false
  result.controllerValidated = false
  await writeFile(resultPath, JSON.stringify(result, null, 2))
  throw error
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

// This receipt is written only after Electron exited successfully, every named
// outcome and artifact passed, the clipboard was restored, and owned data was removed.
await assert.rejects(access(root), { code: 'ENOENT' })
const resultPath = join(evidence, 'result.json')
const result = JSON.parse(await readFile(resultPath, 'utf8'))
assert.equal(result.scope, scope)
assert.equal(result.ok, true)
assert.equal(result.clipboardRestored, true)
assert.equal(child.exitCode, 0)
const finalRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: desktop, encoding: 'utf8' })
assert.equal(finalRevision.status, 0)
assert.equal(
  finalRevision.stdout.trim(),
  sourceHead,
  'source head changed during native acceptance',
)
if (!sourceDirty) {
  const finalStatus = spawnSync('git', ['status', '--porcelain'], {
    cwd: desktop,
    encoding: 'utf8',
  })
  assert.equal(finalStatus.status, 0)
  assert.equal(finalStatus.stdout, '', 'source changed during native acceptance')
}
result.exitCode = child.exitCode
result.controllerValidated = true
result.cleanup = { removed: true, root }
await writeFile(resultPath, JSON.stringify(result, null, 2))
console.log(
  `PASS ${scope} native acceptance; Electron exit 0; clipboard restored; owned root removed`,
)

function clipboardCommand(action, backup = '') {
  const result = spawnSync('osascript', ['-l', 'JavaScript', clipboardScript, action, backup], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
  })
  assert.equal(result.status, 0, `osascript ${action} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}
