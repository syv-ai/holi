import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { externalizeDepsPlugin } from 'electron-vite'
import { createCdpClient } from './native-smoke-cdp.mjs'

// This phase covers real-shell Mail → Compose new email → Subject/To.
// Input travels through CDP, not a physical keyboard or the OS event queue.
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const temporary = await realpath(tmpdir())
let evidence
if (process.argv[2]) {
  const requested = resolve(process.argv[2])
  const parent = await realpath(dirname(requested))
  assert(
    parent === temporary || parent.startsWith(temporary + sep),
    'Evidence must be in a fresh temporary directory',
  )
  evidence = join(parent, requested.slice(dirname(requested).length + 1))
  // Refuse existing directories, including symlinks and their existing files.
  await mkdir(evidence)
} else evidence = await mkdtemp(join(temporary, 'holi-600-evidence-'))
const root = await mkdtemp(join(temporary, 'holi-600-shell-'))
let child, socket, cdp, page, target, closed
let exited = false
let log = ''
let failure, stopSignal, exitStatus
let forcedTermination = false
let processGroupGone = true
let rootRemoved = false
const cases = []
const saves = []
const readState = async () => JSON.parse(await readFile(join(evidence, 'main-state.json'), 'utf8'))
function checkCancellation() {
  if (stopSignal) throw new Error(`Interrupted by ${stopSignal}`)
}
function onSignal(signal) {
  stopSignal = signal
  if (child?.pid && !exited) signalGroup('SIGTERM')
}
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)

async function waitFor(predicate, label) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    checkCancellation()
    if (exited) throw new Error(`Electron exited while waiting for ${label}\n${log}`)
    const value = await predicate()
    if (value) return value
    await pause(60)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function click(expression) {
  const point = await page.evaluate(`(() => {
    const node = ${expression};
    if (!node) throw new Error('Missing click target');
    node.scrollIntoView({block:'center'});
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height) throw new Error('Hidden click target');
    return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`)
  for (const type of ['mousePressed', 'mouseReleased'])
    await page.call('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
}

async function key(key, code, virtual, text) {
  const fields = { key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual }
  await page.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...fields,
    ...(text ? { text, unmodifiedText: text } : {}),
  })
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', ...fields })
}

async function checkField(vim, label) {
  const selector = `input[aria-label="${label}"]`
  await click(`document.querySelector(${JSON.stringify(selector)})`)
  assert.equal(await page.evaluate(`document.activeElement?.getAttribute('aria-label')`), label)
  await page.evaluate('window.__backspaceProof.events.length = 0')
  for (const ch of 'abc')
    await key(ch, `Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0), ch)
  const value = () => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`)
  const before = await value()
  assert.equal(before, 'abc', `${label}: native typing must reach the focused field`)
  await key('Backspace', 'Backspace', 8)
  await waitFor(async () => (await value()) === 'ab', `${label}: Backspace deletion`)
  await pause(60) // Let passive, post-dispatch event samples settle.
  const after = await value()
  const events = await page.evaluate('window.__backspaceProof.events.splice(0)')
  const downs = events.filter((event) => event.type === 'keydown')
  assert.equal(downs.length, 1)
  assert.equal(downs[0].key, 'Backspace')
  assert.equal(downs[0].label, label)
  assert.equal(downs[0].trusted, true)
  assert.equal(downs[0].prevented, false)
  assert(
    events.some(
      (event) =>
        event.type === 'beforeinput' &&
        event.inputType === 'deleteContentBackward' &&
        event.trusted &&
        !event.prevented,
    ),
  )
  cases.push({ vim, route: 'Mail → Compose new email', label, before, after, events })
  await writeFile(join(evidence, 'cases.json'), JSON.stringify(cases, null, 2))
  console.log(`PASS vim=${vim} ${label}: abc → ab`)
}

function signalGroup(signal) {
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

try {
  checkCancellation()
  const electron = process.env.ELECTRON_EXECUTABLE || require('electron')
  await access(electron)
  const sources = [
    'src/renderer/index.html',
    'src/renderer/src/main.tsx',
    'src/preload/index.ts',
    'src/main/menu.ts',
    'scripts/backspace-shell-smoke-main.ts',
    'scripts/run-backspace-shell-smoke.mjs',
  ]
  const hashes = Object.fromEntries(
    await Promise.all(
      sources.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(join(desktop, path)))
          .digest('hex'),
      ]),
    ),
  )
  await writeFile(
    join(evidence, 'scope.json'),
    JSON.stringify(
      {
        input: 'CDP Input.dispatchKeyEvent',
        rendererEntry: 'src/renderer/src/main.tsx',
        rendererHtml: 'src/renderer/index.html',
        preload: 'src/preload/index.ts',
        menu: 'src/main/menu.ts',
        data: 'synthetic main-side IPC fixtures',
        fields: ['Subject', 'To'],
        vim: [false, true],
        remaining: [
          'resumed composers',
          'inline replies',
          'Cc/Bcc',
          'recipient chip deletion',
          'mail bodies',
          'rich notes',
          'plain/code editors',
          'Markdown source and structural deletion',
          'other editable fields',
          'normal-mode Vim',
          'physical-keyboard/OS routing',
        ],
        hashes,
      },
      null,
      2,
    ),
  )
  await build({
    configFile: false,
    root: join(desktop, 'src/renderer'),
    base: './',
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    build: {
      target: 'chrome140',
      outDir: join(root, 'renderer'),
      rollupOptions: { input: join(desktop, 'src/renderer/index.html') },
    },
  })
  for (const [input, name] of [
    ['scripts/backspace-shell-smoke-main.ts', 'main.cjs'],
    ['src/preload/index.ts', 'preload.cjs'],
  ]) {
    checkCancellation()
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
          input: join(desktop, input),
          external: ['electron'],
          output: {
            format: 'cjs',
            entryFileNames: name,
            ...(name === 'main.cjs'
              ? {
                  banner: `module.paths.unshift(${JSON.stringify(join(desktop, 'node_modules'))});`,
                }
              : {}),
          },
        },
      },
    })
  }
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-600-private-smoke', main: 'main.cjs' }),
  )
  const home = join(root, 'home')
  await mkdir(home)
  checkCancellation()
  // No inherited provider credentials, Node hooks, proxy settings or real HOME.
  child = spawn(
    electron,
    [root, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: root,
        LANG: 'en_US.UTF-8',
        HOLI_600_ROOT: root,
        HOLI_600_EVIDENCE: evidence,
        HOLI_VAULT_ROOT: join(root, 'vaults'),
      },
    },
  )
  closed = new Promise((done) => {
    child.once('close', (code, signal) => {
      exited = true
      exitStatus = { code, signal }
      done(exitStatus)
    })
    child.once('error', (error) => {
      exited = true
      log += String(error)
      exitStatus = { error: String(error) }
      done(exitStatus)
    })
  })
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (data) => {
      log += data
      process.stdout.write(data)
    })
  const port = await waitFor(
    () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(log)?.[1],
    'owned debugger port',
  )
  const get = (path) =>
    fetch(`http://127.0.0.1:${port}/${path}`, { signal: AbortSignal.timeout(3000) }).then(
      (response) => response.json(),
    )
  await waitFor(() => log.includes('HOLI_600_READY '), 'initial production document load')
  const version = await get('json/version')
  await writeFile(
    join(evidence, 'runtime.json'),
    JSON.stringify({ ...version, electronPid: child.pid, privateRoot: root }, null, 2),
  )
  socket = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 10_000)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        done()
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
      { once: true },
    )
  })
  cdp = createCdpClient(socket)
  target = await waitFor(
    async () =>
      (await get('json/list')).find(
        (item) => item.type === 'page' && item.url.startsWith('file://' + root),
      ),
    'production renderer target',
  )
  page = await cdp.attach(target.id)
  await page.call('Page.enable')
  await page.call('Runtime.enable')
  await page.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `
    window.__backspaceProof = {events:[],errors:[]};
    for (const type of ['keydown','beforeinput','input','focusout']) window.addEventListener(type, event => {
      if (type === 'keydown' && event.key !== 'Backspace') return;
      const target = event.target;
      const record = {type,key:event.key,inputType:event.inputType,trusted:event.isTrusted,label:target.getAttribute?.('aria-label'),tag:target.tagName,before:target.value??target.textContent};
      window.__backspaceProof.events.push(record);
      setTimeout(() => {record.prevented=event.defaultPrevented;record.after=target.value??target.textContent}, 0);
    }, true);
    window.addEventListener('error', event => window.__backspaceProof.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => window.__backspaceProof.errors.push(String(event.reason)));
  `,
  })
  for (const vim of [false, true]) {
    await page.evaluate(`localStorage.setItem('holi:vimCodeEditing', '${vim}')`)
    await page.call('Page.reload')
    await waitFor(
      () =>
        page.evaluate(
          `document.body?.innerText.includes('Backspace fixture') && !![...document.querySelectorAll('button')].find(node => node.innerText.trim()==='Mail' && node.getBoundingClientRect().width>0)`,
        ),
      'connected shell Mail route',
    )
    assert.equal(await page.evaluate(`localStorage.getItem('holi:vimCodeEditing')`), String(vim))
    await click(
      `[...document.querySelectorAll('button')].find(node => node.innerText.trim()==='Mail' && node.getBoundingClientRect().width>0)`,
    )
    await waitFor(
      () => page.evaluate(`!!document.querySelector('[aria-label="Compose new email"]')`),
      'Mail composition action',
    )
    await click(`document.querySelector('[aria-label="Compose new email"]')`)
    await waitFor(
      () => page.evaluate(`!!document.querySelector('input[aria-label="Subject"]')`),
      'standalone composer',
    )
    const baseline = (await readState()).saves.length
    await checkField(vim, 'Subject')
    // Keep Subject focused through production's two-second idle debounce.
    const saved = await waitFor(async () => {
      const state = await readState()
      return state.saves.length > baseline ? state.saves[baseline] : null
    }, `vim=${vim}: a fresh idle draft save`)
    assert.equal(
      await page.evaluate(`document.activeElement?.getAttribute('aria-label')`),
      'Subject',
    )
    assert.equal(
      await page.evaluate(
        `window.__backspaceProof.events.some(event => event.type==='focusout' && event.label==='Subject')`,
      ),
      false,
      'Subject must not blur before its idle save',
    )
    assert.deepEqual(saved.mail.to, [])
    assert.equal(saved.mail.subject, 'ab')
    assert.equal(saved.mail.body, '')
    assert.equal(saved.mail.html, '')
    saves.push({ vim, trigger: 'idle', ...saved })
    await key('x', 'KeyX', 88, 'x')
    assert.equal(
      await page.evaluate(`document.querySelector('input[aria-label="Subject"]').value`),
      'abx',
    )
    await checkField(vim, 'To')
    const updated = await waitFor(async () => {
      const state = await readState()
      return state.saves.length > baseline + 1 ? state.saves[baseline + 1] : null
    }, `vim=${vim}: blur updates the existing draft`)
    assert.equal(updated.draftId, saved.draftId)
    assert.equal(updated.mail.subject, 'abx')
    assert.deepEqual(updated.mail.to, [])
    saves.push({ vim, trigger: 'blur', ...updated })
    await writeFile(join(evidence, 'saves.json'), JSON.stringify(saves, null, 2))
    assert.deepEqual(await page.evaluate('window.__backspaceProof.errors'), [])
    const shot = await page.call('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(evidence, `vim-${vim}.png`), Buffer.from(shot.data, 'base64'))
    const state = await readState()
    assert.deepEqual(state.missing, [], 'Every consumed RPC must have a fixture contract')
    assert.deepEqual(state.errors, [], 'Renderer and IPC must remain error-free')
  }
} catch (error) {
  failure = error
  if (page) {
    try {
      await writeFile(
        join(evidence, 'failure-body.txt'),
        await page.evaluate('document.body?.innerText ?? ""'),
      )
      const shot = await page.call('Page.captureScreenshot', { format: 'png' })
      await writeFile(join(evidence, 'failure.png'), Buffer.from(shot.data, 'base64'))
    } catch {
      /* Preserve the original failure if the renderer has exited. */
    }
  }
} finally {
  try {
    if (cdp && target && !exited) {
      try {
        await cdp.call('Target.closeTarget', { targetId: target.id })
      } catch {
        /* Exit status and final state below decide shutdown success. */
      }
    }
    cdp?.close()
    socket?.close()
    if (child?.pid) {
      await Promise.race([closed, pause(2000)])
      if (!exited) {
        forcedTermination = true
        signalGroup('SIGTERM')
        await Promise.race([closed, pause(2000)])
      }
      const groupExists = () => {
        try {
          process.kill(-child.pid, 0)
          return true
        } catch (error) {
          if (error.code === 'ESRCH') return false
          throw error
        }
      }
      if (groupExists()) {
        forcedTermination = true
        signalGroup('SIGKILL')
      }
      if (!exited) await Promise.race([closed, pause(2000)])
      const deadline = Date.now() + 2000
      while (groupExists() && Date.now() < deadline) await pause(50)
      processGroupGone = !groupExists()
      assert(processGroupGone, 'Owned Electron process group must terminate')
      assert(exited, 'Electron exit must be observed')
      assert.deepEqual(exitStatus, { code: 0, signal: null }, 'Electron must shut down cleanly')
      assert.equal(forcedTermination, false, 'Successful evidence requires graceful shutdown')
      const state = await readState()
      assert.deepEqual(state.missing, [], 'Final IPC report must have no missing contracts')
      assert.deepEqual(state.errors, [], 'Final report must remain error-free through shutdown')
      assert.equal(
        state.saves.length,
        saves.length,
        'All draft saves must belong to measured iterations',
      )
    }
  } catch (error) {
    failure ??= error
  } finally {
    await writeFile(join(evidence, 'run.log'), log)
    if (processGroupGone) {
      await rm(root, { recursive: true, force: true })
      rootRemoved = true
    }
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}
if (stopSignal) failure ??= new Error(`Interrupted by ${stopSignal}`)
await writeFile(
  join(evidence, 'result.json'),
  JSON.stringify(
    {
      status: failure ? 'failed' : 'passed',
      cases: cases.length,
      scope: 'new standalone composer Subject/To, Vim off/on; per-iteration idle saves',
      input: 'CDP',
      issueReproduced: false,
      ...(failure ? { message: String(failure) } : {}),
      cleanup: { exitStatus, forcedTermination, processGroupGone, rootRemoved },
    },
    null,
    2,
  ),
)
console.log(`Evidence: file://${evidence}`)
if (failure) throw failure
