import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { externalizeDepsPlugin } from 'electron-vite'
import { runPiNativeTuiFixture } from '../../../scripts/pi-native-tui-fixture.mjs'
import { verifyPiProvenance } from '../../../scripts/pi-native-tui-provenance.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(desktop, '../..')
const [bin, expectedVersion, destination] = process.argv.slice(2)
assert(
  bin && expectedVersion && destination,
  'usage: node run-pi-link-hints-native-smoke.mjs BIN VERSION OUTSIDE_REPO_EVIDENCE',
)
await verifyPiProvenance({ bin, expectedVersion })
await mkdir(destination, { recursive: true })
const evidence = await realpath(destination)
assert(relative(repository, evidence).startsWith('..'), 'evidence must be outside the repository')
assert.deepEqual(await readdir(evidence), [], 'evidence directory must be empty')
const root = await mkdtemp(join(tmpdir(), 'holi-805-native-'))
const token = randomBytes(24).toString('hex')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let terminal,
  geometry,
  child,
  closed,
  ws,
  cdp,
  evaluate,
  log = '',
  inputQueue = Promise.resolve()
const inputs = [],
  cases = [],
  frames = []
const bridge = createServer(async (request, response) => {
  try {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end()
      return
    }
    const url = new URL(request.url, 'http://127.0.0.1')
    let result = null
    if (request.method === 'GET' && url.pathname === '/output') {
      const output = terminal?.output ?? Buffer.alloc(0)
      const offset = Number(url.searchParams.get('offset'))
      assert(Number.isSafeInteger(offset) && offset >= 0 && offset <= output.length)
      result = { offset: output.length, data: output.subarray(offset).toString('base64') }
    } else if (request.method === 'POST') {
      let body = ''
      for await (const chunk of request) {
        body += chunk
        assert(body.length <= 65536)
      }
      const value = JSON.parse(body)
      if (url.pathname === '/geometry') {
        assert(Number.isInteger(value.cols) && Number.isInteger(value.rows))
        geometry = value
      } else if (url.pathname === '/input') {
        assert(terminal && typeof value.data === 'string', 'native producer must own input')
        inputs.push([...Buffer.from(value.data)])
        inputQueue = inputQueue.then(() => terminal.write(value.data))
        await inputQueue
      } else throw new Error('unknown fixture bridge path')
    } else throw new Error('unknown fixture bridge operation')
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
  } catch (error) {
    response.writeHead(400).end(JSON.stringify({ error: error.message }))
  }
})
let outcome = 'unverified',
  error,
  native,
  shutdown,
  video
try {
  await new Promise((resolve, reject) => {
    bridge.once('error', reject)
    bridge.listen(0, '127.0.0.1', resolve)
  })
  for (const name of ['home', 'profile', 'session', 'frames']) await mkdir(join(root, name))
  const rendererBuild = await build({
    configFile: false,
    root: desktop,
    base: './',
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    build: {
      target: 'chrome140',
      outDir: join(root, 'renderer'),
      rollupOptions: {
        input: fileURLToPath(new URL('./pi-link-hints-native-smoke.tsx', import.meta.url)),
      },
    },
  })
  const rendererOutput = [rendererBuild].flat().flatMap((result) => result.output)
  const entry = rendererOutput.find((item) => item.type === 'chunk' && item.isEntry)
  assert(entry, 'native renderer entry missing')
  const styles = rendererOutput
    .filter((item) => item.fileName.endsWith('.css'))
    .map((item) => `<link rel="stylesheet" href="./${item.fileName}">`)
    .join('')
  await writeFile(
    join(root, 'renderer/index.html'),
    `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'"><title>Pi link acceptance</title>${styles}</head><body><div id="root"></div><script type="module" src="./${entry.fileName}"></script></body></html>`,
  )
  for (const [input, name] of [
    [fileURLToPath(new URL('./pi-link-hints-native-smoke-main.ts', import.meta.url)), 'main.cjs'],
    [fileURLToPath(new URL('../src/preload/index.ts', import.meta.url)), 'preload.cjs'],
  ]) {
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
          input,
          external: ['electron'],
          output: {
            format: 'cjs',
            entryFileNames: name,
            banner:
              name === 'main.cjs'
                ? `module.paths.unshift(${JSON.stringify(join(desktop, 'node_modules'))});`
                : '',
          },
        },
      },
    })
  }
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-pi-link-hints-805', main: 'main.cjs' }),
  )
  // Let Electron allocate its own isolated debugging endpoint; no shared fixed port.
  const electron = createRequire(import.meta.url)('electron')
  const env = {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    HOME: join(root, 'home'),
    TMPDIR: tmpdir(),
    HOLI_805_ROOT: root,
    HOLI_805_EVIDENCE: evidence,
    HOLI_805_BRIDGE: `http://127.0.0.1:${bridge.address().port}`,
    HOLI_805_TOKEN: token,
  }
  child = spawn(electron, [root, '--remote-debugging-port=0'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      log += chunk
      process.stdout.write(chunk)
    })
  let endpoint
  for (let n = 0; n < 120 && !endpoint; n++) {
    endpoint = log.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1]
    if (!endpoint) await delay(100)
  }
  assert(endpoint, 'isolated Electron debugging endpoint missing')
  const port = new URL(endpoint).port
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = targets.find((item) => item.type === 'page')
  assert(target?.webSocketDebuggerUrl)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let serial = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Page.screencastFrame') {
      frames.push({ at: Date.now(), bytes: Buffer.from(message.params.data, 'base64') })
      ws.send(
        JSON.stringify({
          id: --serial,
          method: 'Page.screencastFrameAck',
          params: { sessionId: message.params.sessionId },
        }),
      )
    } else if (pending.has(message.id)) {
      const call = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(call.timer)
      message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result)
    }
  })
  let callId = 0
  cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++callId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP deadline: ${method}`))
      }, 10000)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const waitFor = async (expression, label) => {
    for (let n = 0; n < 100; n++) {
      const result = await evaluate(expression)
      if (result) return result
      await delay(100)
    }
    const diagnostic = await evaluate('window.piHintFixtureState?.()')
    await writeFile(
      join(evidence, 'failure-state.json'),
      JSON.stringify({ label, diagnostic, proof: await proof() }, null, 2),
    )
    throw new Error(`timeout: ${label}; ${await evaluate('document.body.innerText')}`)
  }
  const key = async (key, modifiers = 0) => {
    const fields = {
      key,
      modifiers,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      windowsVirtualKeyCode: key === 'Escape' ? 27 : key.toUpperCase().charCodeAt(0),
    }
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...fields,
      ...(key.length === 1 && !modifiers ? { text: key } : {}),
    })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...fields })
  }
  const proof = () => evaluate(`window.holi.trpc({path:'fixture.proof'}).then(r=>r.data)`)
  const link = `document.querySelector('[data-hint-target="https://example.invalid/fixture"]')`
  const hints = async () => {
    // The producer's recovery prefix precedes its final redraw. Request only once
    // that native redraw has reached the renderer and its paint has settled.
    let ready = false
    for (let n = 0; n < 100; n++) {
      const bytes = terminal.output.length
      await delay(200)
      if (terminal.output.length === bytes && (await proof()).offset === bytes) {
        ready = true
        break
      }
    }
    assert(ready, 'native output did not settle at the renderer bridge')
    await evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    )
    await evaluate(`document.getElementById('host-focus').focus()`)
    await key('f')
    const label = await waitFor(`${link}?.getAttribute('data-hint-key')`, 'native link hint')
    await evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    )
    const labels = await evaluate(
      `Array.from(document.querySelectorAll('[data-hint-target]')).map(e=>e.getAttribute('data-hint-target'))`,
    )
    assert(
      !labels.some((label) => /allow this tool|Yes|No\./.test(label)),
      'native-looking prose became a target',
    )
    return label
  }
  const cancel = async () => {
    await key('Escape')
    await waitFor(`!document.querySelector('[data-host-hints]')`, 'cancel hints')
  }
  const snapshot = async (name) => {
    const image = await cdp('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(evidence, `${name}.png`), Buffer.from(image.data, 'base64'))
  }
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await waitFor('typeof window.piHintFixture === "function"', 'production terminal fixture')
  for (let n = 0; n < 100 && !geometry; n++) await delay(100)
  assert(geometry, 'real terminal geometry missing')
  const initialGeometry = { ...geometry }
  native = await runPiNativeTuiFixture({
    bin,
    expectedVersion,
    artifactDirectory: join(evidence, 'producer'),
    timeout: 180000,
    terminalSize: { columns: initialGeometry.cols, rows: initialGeometry.rows },
    observeTerminal: async (handle) => {
      terminal = handle
      await cdp('Page.startScreencast', {
        format: 'jpeg',
        quality: 75,
        maxWidth: 980,
        maxHeight: 680,
      })
      for (const path of ['surface', 'agents']) {
        await evaluate(`window.piHintFixture({path:${JSON.stringify(path)}})`)
        if (path === 'agents')
          await waitFor(
            `!!document.querySelector('[data-agents-main="session"] [data-session-terminal]')`,
            'actual second caller',
          )
        for (const theme of ['light', 'dark']) {
          await evaluate(`window.piHintFixture({theme:${JSON.stringify(theme)}})`)
          const label = await hints()
          await snapshot(`${path}-${theme}`)
          const before = (await proof()).opened.length
          for (const character of label) await key(character)
          await waitFor(
            `window.holi.trpc({path:'fixture.proof'}).then(r=>r.data.opened.length===${before + 1})`,
            'original modifier-sensitive activation callback',
          )
          cases.push({ path, theme, action: 'native-link-activation', status: 'pass' })
        }
      }
      await evaluate(`window.piHintFixture({path:'surface'})`)
      const mutations = [
        [
          'provider',
          `window.piHintFixture({provider:'claude'});window.piHintFixture({provider:'pi'})`,
        ],
        [
          'ownership',
          `window.piHintFixture({owner:null});window.piHintFixture({owner:'native-pi-hint-session'})`,
        ],
        [
          'account',
          `window.piHintFixture({account:'other'});window.piHintFixture({account:'isolated-native-fixture'})`,
        ],
        [
          'vault',
          `window.piHintFixture({remote:'other/vault'});window.piHintFixture({remote:'native-fixture/pi-links'})`,
        ],
      ]
      for (const [name, mutation] of mutations) {
        const label = await hints(),
          before = (await proof()).opened.length
        await evaluate(mutation)
        for (const character of label) await key(character)
        assert.equal(
          (await proof()).opened.length,
          before,
          `${name} A-to-B-to-A activated stale target`,
        )
        await cancel()
        cases.push({ action: `${name}-a-b-a-rejected`, status: 'pass' })
      }
      let label = await hints(),
        before = (await proof()).opened.length
      await evaluate(`window.piHintFixture({visible:false})`)
      await waitFor(`!!document.querySelector('[hidden]')`, 'hidden terminal')
      for (const character of label) await key(character)
      assert.equal((await proof()).opened.length, before)
      await evaluate(`window.piHintFixture({visible:true})`)
      await cancel()
      cases.push({ action: 'hidden-target-rejected', status: 'pass' })
      label = await hints()
      before = (await proof()).opened.length
      const outputBefore = handle.output.length
      await handle.write('f')
      for (let n = 0; n < 100 && handle.output.length === outputBefore; n++) await delay(20)
      assert(handle.output.length > outputBefore, 'real native redraw missing')
      await waitFor(
        `window.holi.trpc({path:'fixture.proof'}).then(r=>r.data.offset>${outputBefore})`,
        'native redraw admitted by renderer bridge',
      )
      for (const character of label) await key(character)
      assert.equal((await proof()).opened.length, before)
      await cancel()
      await handle.write('\u007f')
      cases.push({ action: 'live-native-output-invalidates', status: 'pass' })
      await evaluate(`document.querySelector('.xterm-helper-textarea').focus()`)
      const writesBefore = (await proof()).writes.length
      await key('f')
      await waitFor(
        `window.holi.trpc({path:'fixture.proof'}).then(r=>r.data.writes.slice(${writesBefore}).includes('f'))`,
        'plain f preserved as native PTY input',
      )
      await key('c', 2)
      await waitFor(
        `window.holi.trpc({path:'fixture.proof'}).then(r=>r.data.writes.slice(${writesBefore}).includes('\\u0003'))`,
        'native Ctrl+C input preserved',
      )
      await inputQueue
      await cancel()
      cases.push({ action: 'plain-f-passthrough', status: 'pass' })
      await snapshot('native-input')
      await cdp('Page.stopScreencast')
      const receipt = await proof()
      await writeFile(
        join(evidence, 'renderer-proof.json'),
        JSON.stringify({ initialGeometry, ...receipt, cases, inputs }, null, 2),
      )
      return {
        renderer:
          'production AgentSurface and AgentsView SessionTerminal with production preload and agentEvents',
        cases,
        initialGeometry,
        opened: receipt.opened,
        nativeInput: inputs,
        externalNavigation: 'recorded callback only; no browser launch or URL request',
        producerResize:
          'initial native PTY uses measured renderer geometry; dynamic producer resizing not exercised',
      }
    },
  })
  assert.equal(native.outcome, 'pass', native.detail)
  assert.equal(native.source.dirty, false, 'acceptance requires a committed feature state')
  outcome = 'pass'
} catch (caught) {
  error = caught
  console.error(caught)
} finally {
  if (evaluate) await evaluate(`window.holi.trpc({path:'fixture.quit'})`).catch(() => {})
  if (child) {
    shutdown = await Promise.race([closed, delay(5000).then(() => null)])
    if (!shutdown) {
      child.kill('SIGTERM')
      shutdown = await Promise.race([closed, delay(5000).then(() => null)])
    }
    if (!shutdown) {
      child.kill('SIGKILL')
      shutdown = await closed
    }
  }
  ws?.close()
  bridge.closeAllConnections()
  if (bridge.listening) await new Promise((resolve) => bridge.close(resolve))
  if (frames.length) {
    const lines = ['ffconcat version 1.0']
    for (let n = 0; n < frames.length; n++) {
      const file = join(root, 'frames', `${n}.jpg`)
      await writeFile(file, frames[n].bytes)
      lines.push(
        `file '${file}'`,
        `duration ${Math.max(0.04, ((frames[n + 1]?.at ?? frames[n].at + 250) - frames[n].at) / 1000)}`,
      )
    }
    await writeFile(join(root, 'frames.ffconcat'), lines.join('\n'))
    const rendered = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        join(root, 'frames.ffconcat'),
        '-vf',
        'fps=12,format=yuv420p',
        '-movflags',
        '+faststart',
        join(evidence, 'interaction.mp4'),
      ],
      { encoding: 'utf8', timeout: 60000 },
    )
    if (rendered.status === 0)
      video = {
        file: 'interaction.mp4',
        sha256: createHash('sha256')
          .update(await readFile(join(evidence, 'interaction.mp4')))
          .digest('hex'),
      }
    else {
      outcome = 'unverified'
      error ??= new Error(`interaction encoding failed: ${rendered.stderr}`)
    }
  }
  await writeFile(join(evidence, 'electron.log'), log)
  await rm(root, { recursive: true, force: true })
  await writeFile(
    join(evidence, 'result.json'),
    JSON.stringify(
      {
        outcome,
        detail: error?.message,
        nativeOutcome: native?.outcome,
        cases,
        video,
        cleanup: { electron: shutdown, bridgeClosed: !bridge.listening, scratchRemoved: true },
      },
      null,
      2,
    ),
  )
}
if (outcome !== 'pass') process.exitCode = 1
console.log(JSON.stringify({ outcome, evidence, cases: cases.length }))
