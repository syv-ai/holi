import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { externalizeDepsPlugin } from 'electron-vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(process.argv[2] ?? '/tmp/holi-563-evidence')
const root = await mkdtemp(join(tmpdir(), 'holi-563-native-'))
let child
let closed
let log = ''
let ws
let nextId = 0
const pending = new Map()
let successResult
try {
  await mkdir(evidence, { recursive: true })
  for (const name of ['result.json', 'electron-smoke.log', 'composer.png'])
    await rm(join(evidence, name), { force: true })
  await build({
    configFile: false,
    root: desktop,
    base: './',
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'mail-vim-synthetic-adapters',
        enforce: 'pre',
        transform(_code, id) {
          if (id.endsWith('/src/plugins/google/renderer/account.ts'))
            return `export function useGoogleAccount(){return {currentSub:'fixture-account-a',account:{sub:'fixture-account-a'},loading:false,readError:false,missingScopes:[],needsReconnect:false,accounts:[],refresh:()=>{},refreshAndWait:async()=>{}}}`
          if (id.endsWith('/src/plugins/google/renderer/google-cap.ts'))
            return `const calls=()=>window.__mailVimCalls; export const googleCap={draftBody:async(_remote,{id})=>({to:[],cc:[],bcc:[],subject:'Draft '+id,text:'',html:null,markdown:'',foreign:false,threadId:null}),saveDraft:async(_remote,input)=>{calls().push({op:'saveDraft',account:input.expectedAccountSub,payload:input.mail});return{id:'synthetic-draft'}},send:async()=>{calls().push({op:'send-rejected'});throw new Error('Native smoke blocks sending')},discardDraft:async(_remote,input)=>{calls().push({op:'discardDraft',account:input.expectedAccountSub});return{} }}`
          return null
        },
      },
    ],
    build: {
      target: 'chrome140',
      outDir: join(root, 'renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: join(desktop, 'scripts/mail-vim-native-smoke.tsx'),
        output: { entryFileNames: 'renderer.js', assetFileNames: 'renderer.[ext]' },
      },
    },
  })
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
        input: join(desktop, 'scripts/mail-vim-native-smoke-main.ts'),
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
    join(root, 'renderer', 'index.html'),
    `<!doctype html><html data-theme="dark"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; frame-src 'self'; connect-src 'none'"><title>Mail Vim native smoke</title><link rel="stylesheet" href="./renderer.css"></head><body><div id="root"></div><script type="module" src="./renderer.js"></script></body></html>`,
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-mail-vim-native-smoke-563', main: 'main.cjs' }),
  )
  const electron = createRequire(import.meta.url)('electron')
  const env = {
    ...process.env,
    HOLI_563_ROOT: root,
    HOLI_563_EVIDENCE: evidence,
    HOLI_VAULT_ROOT: join(root, 'disposable-vault'),
    NODE_PATH: [join(desktop, 'node_modules'), process.env.NODE_PATH]
      .filter(Boolean)
      .join(delimiter),
  }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [root, '--remote-debugging-port=0'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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
  const wait = async (fn, label, timeout = 30000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const value = await Promise.resolve()
        .then(fn)
        .catch(() => null)
      if (value) return value
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(
      `Timed out waiting for ${label}: ${await evaluate(`JSON.stringify({body:document.body.innerText,inputs:[...document.querySelectorAll('input')].map(e=>({label:e.getAttribute('aria-label'),value:e.value})),errors:window.__mailVimErrors})`).catch((error) => String(error))}`,
    )
  }
  const portMatch = await wait(() => {
    const match = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(log)
    return match?.[1]
  }, 'Electron DevTools endpoint')
  const response = await fetch(`http://127.0.0.1:${portMatch}/json/version`).then((r) => r.json())
  ws = new WebSocket(response.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const p = pending.get(message.id)
    if (p) {
      pending.delete(message.id)
      message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result)
    }
  })
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const target = await wait(
    async () =>
      (await (await fetch(`http://127.0.0.1:${portMatch}/json/list`)).json()).find(
        (t) => t.type === 'page',
      ),
    'renderer target',
  )
  const { sessionId } = await call('Target.attachToTarget', { targetId: target.id, flatten: true })
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, sessionId, method, params }))
    })
  await cdp('Runtime.enable')
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  const until = (expression, label) => wait(() => evaluate(expression), label)
  const key = async (keyName, modifiers = 0) => {
    const code = keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName
    const text = keyName.length === 1 ? keyName : undefined
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: keyName,
      code,
      modifiers,
      text,
      unmodifiedText: text,
      windowsVirtualKeyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : undefined,
    })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, modifiers })
  }
  const insertText = (text) => cdp('Input.insertText', { text })
  const clickText = async (text) => {
    const rect = await evaluate(
      `(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    )
    assert(rect, `missing button ${text}`)
    await cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...rect,
      button: 'left',
      clickCount: 1,
    })
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...rect,
      button: 'left',
      clickCount: 1,
    })
  }
  const clickButtonContaining = async (text) => {
    const rect = await evaluate(
      `(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.includes(${JSON.stringify(text)}));if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    )
    assert(rect, `missing button containing ${text}`)
    await cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...rect,
      button: 'left',
      clickCount: 1,
    })
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...rect,
      button: 'left',
      clickCount: 1,
    })
  }
  const click = async (selector) => {
    const rect = await evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    )
    assert(rect, `missing ${selector}`)
    await cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...rect,
      button: 'left',
      clickCount: 1,
    })
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...rect,
      button: 'left',
      clickCount: 1,
    })
  }
  await until(`!!document.querySelector('[aria-label="To"]')`, 'composer recipient input')
  await evaluate(
    `window.__mailVimTrusted=[];document.addEventListener('keydown',e=>window.__mailVimTrusted.push(e.isTrusted),true)`,
  )
  // Edit actual text beside a committed chip; Tab/Enter semantics remain native.
  await click('[aria-label="To"]')
  await insertText('alice@example.test')
  await key('Enter')
  await until(
    `document.querySelector('[data-testid="chip"]')?.textContent.includes('alice@example.test')`,
    'To recipient chip',
  )
  const chipsAfterSuggestion = await evaluate(
    `document.querySelectorAll('[data-testid="chip"]').length`,
  )
  await key('Enter')
  assert.equal(
    await evaluate(`document.querySelectorAll('[data-testid="chip"]').length`),
    chipsAfterSuggestion,
    'empty Enter created a chip',
  )
  assert.equal(
    await evaluate(`window.__mailVimCalls.some(c=>c.op==='send'||c.op==='send-rejected')`),
    false,
    'Enter unexpectedly attempted to send mail',
  )
  await click('[aria-label="To"]')
  await insertText('charlie@example.test')
  await key('Escape')
  await key('Enter')
  assert.equal(
    await evaluate(`document.querySelectorAll('[data-testid="chip"]').length`),
    chipsAfterSuggestion,
    'normal-mode Enter committed an uncommitted recipient',
  )
  assert.equal(
    await evaluate(`window.__mailVimCalls.some(c=>c.op==='send'||c.op==='send-rejected')`),
    false,
    'normal-mode Enter attempted to send mail',
  )
  await key('i')
  await key('Enter')
  await until(
    `[...document.querySelectorAll('[data-testid="chip"]')].some(chip=>chip.textContent.includes('charlie@example.test'))`,
    'insert-mode recipient commit',
  )
  await click('button') // host action; then refocus recipient field
  await clickText('Cc')
  await until(`!!document.querySelector('[aria-label="Cc"]')`, 'Cc editable recipient field')
  await click('[aria-label="Cc"]')
  await insertText('alice@example.test')
  await key('Tab')
  await until(
    `document.querySelector('[aria-label="Cc"]')!==null&&document.querySelectorAll('[data-testid="chip"]').length>=3`,
    'Cc native Tab commit',
  )
  await clickText('Bcc')
  await until(`!!document.querySelector('[aria-label="Bcc"]')`, 'Bcc editable recipient field')
  await click('[aria-label="Bcc"]')
  await insertText('not-an-address')
  await key('Enter')
  assert.equal(
    await evaluate(
      `document.querySelector('[aria-label="Bcc"]').getAttribute('aria-invalid')==='true'`,
    ),
    true,
    'invalid Bcc address was not rejected',
  )
  await key('a', process.platform === 'darwin' ? 4 : 2)
  await key('Backspace')
  await insertText('bob@example.test')
  await key('Enter')
  await until(
    `document.querySelectorAll('[data-testid="chip"]').length>=4`,
    'Bcc native Enter commit',
  )
  await key('Backspace')
  await until(
    `document.querySelectorAll('[data-testid="chip"]').length===3`,
    'native Backspace removes final recipient chip',
  )
  await insertText('bob@example.test')
  await key('Enter')
  await until(
    `document.querySelectorAll('[data-testid="chip"]').length===4`,
    'Bcc recipient available for payload persistence',
  )
  await key('Escape')
  await click('[aria-label="To"]')
  await key('f')
  assert.equal(
    await evaluate(`document.querySelector('[data-host-hints]')!==null`),
    false,
    'insert-mode f opened hints',
  )
  assert.equal(
    await evaluate(`document.querySelector('[aria-label="To"]').value`),
    'f',
    'insert-mode f was not inserted as text',
  )
  await key('Escape')
  await click('[aria-label="Subject"]')
  await key('Escape')
  await key('f')
  await until(`document.querySelector('[data-host-hints]')!==null`, 'normal-mode host hints')
  await key('Escape')
  assert.equal(
    await evaluate(`document.querySelector('[data-host-hints]')===null`),
    true,
    'Escape did not cancel host hints',
  )
  await key('i')
  await insertText('Draft subject')
  await key('Escape')
  await key('0')
  await key('v')
  await key('l')
  await key('d')
  await key('Escape')
  assert.notEqual(
    await evaluate(`document.querySelector('[aria-label="Subject"]').value`),
    'Draft subject',
    'visual delete did not edit the subject',
  )
  await key('u')
  await until(
    `document.querySelector('[aria-label="Subject"]').value.includes('Draft subject')`,
    'subject undo restoration',
  )
  await click('[aria-label="Subject"]')
  await key('Escape')
  await key('d')
  // Invoke the toggle without moving focus, so only its identity change can reset Vim.
  await evaluate(
    `[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Preview').click()`,
  )
  await until(
    `document.querySelector('[aria-label="Vim insert mode"]')!==null`,
    'preview identity reset with subject still focused',
  )
  assert.equal(
    await evaluate(`document.activeElement===document.querySelector('[aria-label="Subject"]')`),
    true,
    'preview transition blurred subject before testing identity invalidation',
  )
  await evaluate(
    `[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Edit').click()`,
  )
  assert.equal(
    await evaluate(`document.body.innerText.includes('INSERT')`),
    true,
    'preview toggle did not reset pending Vim operator mode',
  )
  await evaluate(`window.__mailVimFlush?.()`)
  await wait(
    () => evaluate(`window.__mailVimCalls.some(c=>c.op==='saveDraft')`),
    'synthetic draft persistence',
  )
  const saved = await evaluate(
    `JSON.stringify(window.__mailVimCalls.filter(c=>c.op==='saveDraft'))`,
  ).then(JSON.parse)
  assert(
    saved.some((entry) => entry.payload.to.includes('alice@example.test')),
    'recipient missing from persisted payload',
  )
  assert(
    saved.some((entry) => entry.payload.cc?.includes('alice@example.test')),
    'Cc recipient missing from persisted payload',
  )
  assert(
    saved.some((entry) => entry.payload.bcc?.includes('bob@example.test')),
    'Bcc recipient missing from persisted payload',
  )
  assert(
    saved.some((entry) => entry.payload.subject.includes('Draft subject')),
    'subject missing from persisted payload',
  )
  const disposableDraft = join(root, 'disposable-vault', 'draft.json')
  await mkdir(dirname(disposableDraft), { recursive: true })
  await writeFile(disposableDraft, JSON.stringify(saved.at(-1).payload, null, 2))
  assert((await stat(disposableDraft)).size > 0, 'synthetic saved draft was not written to disk')
  assert.equal(
    await evaluate(
      `window.__mailVimCalls.some(c=>c.op==='send'||c.op==='discardDraft'||c.op.endsWith('callback'))`,
    ),
    false,
    'unexpected send/discard/close action',
  )
  await evaluate(`window.__mailVim.vim(false)`)
  await click('[aria-label="Subject"]')
  await key('End')
  await insertText('x')
  assert.equal(
    await evaluate(`document.querySelector('[aria-label="Subject"]').value.endsWith('x')`),
    true,
    'Vim-disabled subject did not retain native editing',
  )
  await evaluate(`window.__mailVim.vim(true)`)
  await click('button')
  await click('[aria-label="Subject"]')
  assert.equal(
    await evaluate(`document.body.innerText.includes('INSERT')`),
    true,
    'blur/refocus did not reset the field to insert mode',
  )
  assert.equal(
    await evaluate(`window.__mailVimTrusted.length>0&&window.__mailVimTrusted.every(Boolean)`),
    true,
    'keyboard events were not trusted native events',
  )
  await click('[aria-label="Subject"]')
  await key('Escape')
  await key('d')
  await evaluate(`window.__mailVim.context('fixture-account-b','replacement')`)
  await until(
    `window.__mailVim.state().account==='fixture-account-b'&&window.__mailVim.state().draft==='replacement'`,
    'draft context update on mounted composer',
  )
  assert.equal(
    await evaluate(`JSON.stringify(window.__mailVim.state())`),
    JSON.stringify({
      account: 'fixture-account-b',
      draft: 'replacement',
      readerVisible: true,
      readerView: 'thread-a',
      vault: 'synthetic/mail-vim-vault',
    }),
    'fixture context did not update without remounting the composer',
  )
  assert.equal(
    await evaluate(`document.body.innerText.includes('INSERT')`),
    true,
    'draft/account identity change did not invalidate pending Vim command',
  )
  await clickText('Discard')
  await until(`document.body.innerText.includes('Discard this draft?')`, 'discard confirmation')
  await clickText('Keep')
  assert.equal(
    await evaluate(
      `window.__mailVimCalls.some(c=>c.op==='send'||c.op==='send-rejected'||c.op==='discardDraft'||c.op.endsWith('callback'))`,
    ),
    false,
    'confirmation test performed a send, discard, or close action',
  )
  const composerScreenshot = await cdp('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
  })
  await writeFile(join(evidence, 'composer.png'), Buffer.from(composerScreenshot.data, 'base64'))
  await evaluate(`window.__mailVim.hideComposer()`)
  await until(
    `document.querySelector('[aria-label="Compose mail"]')===null`,
    'composer teardown before isolated frame hints',
  )
  await click('button')
  await key('Escape')
  const framePoint = await evaluate(
    `(()=>{const f=document.querySelector('iframe[aria-label="Message from Fixture"]');const p=f.contentDocument.querySelector('p');const a=f.getBoundingClientRect(),b=p.getBoundingClientRect();return{x:a.left+b.left+b.width/2,y:a.top+b.top+b.height/2}})()`,
  )
  await cdp('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...framePoint,
    button: 'left',
    clickCount: 1,
  })
  await cdp('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...framePoint,
    button: 'left',
    clickCount: 1,
  })
  await key('f')
  await until(
    `document.querySelector('[data-host-hints] [data-hint-target="Expand fixture details"]')!==null&&document.querySelector('[data-host-hints] [data-hint-target="Fixture external link"]')!==null`,
    'owned mail-document hints beside host targets',
  )
  const hintScreenshot = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(
    join(evidence, 'mail-document-hints.png'),
    Buffer.from(hintScreenshot.data, 'base64'),
  )
  const externalLinkLabel = await evaluate(
    `document.querySelector('[data-hint-target="Fixture external link"]').getAttribute('data-hint-key')`,
  )
  for (const character of externalLinkLabel) await key(character)
  await until(
    `window.__mailVimCalls.some(c=>c.op==='openExternal'&&c.payload==='https://example.test/')`,
    'mail link routed through the host external-link bridge',
  )
  await clickButtonContaining('fixture.txt')
  await until(
    `window.__mailVimCalls.some(c=>c.op==='openExternal'&&c.payload==='https://example.test/thread')`,
    'mail attachment action opens its provider thread through the host bridge',
  )
  assert.equal(
    await evaluate(
      `window.__mailVimCalls.some(c=>c.op==='mark-read'||c.op==='send'||c.op==='discardDraft')`,
    ),
    false,
    'mail hint/attachment path caused an unrelated thread or draft side effect',
  )
  await key('Escape')
  await key('f')
  await until(
    `document.querySelector('[data-host-hints] [data-hint-target="Expand fixture details"]')!==null`,
    'mail detail hints remain available after safe link and attachment actions',
  )
  const detailsLabel = await evaluate(
    `document.querySelector('[data-hint-target="Expand fixture details"]').getAttribute('data-hint-key')`,
  )
  for (const character of detailsLabel) await key(character)
  await until(
    `document.querySelector('iframe[aria-label="Message from Fixture"]').contentDocument.querySelector('details').open`,
    'native details disclosure activation through the host coordinator',
  )
  await click('button')
  await key('f')
  await until(
    `document.querySelector('[data-host-hints]')!==null`,
    'hint session before retained hide',
  )
  const retainedFrameToken = await evaluate(
    `(()=>{window.__mailRetainedFrame=document.querySelector('iframe[aria-label="Message from Fixture"]');return true})()`,
  )
  assert.equal(retainedFrameToken, true)
  const staleLinkKey = await evaluate(
    `document.querySelector('[data-hint-target="Fixture external link"]')?.getAttribute('data-hint-key')`,
  )
  assert(staleLinkKey, 'retained reader session has a native target to invalidate')
  await evaluate(
    `window.__mailVim.reader(false,'fixture-account-a','thread-a','synthetic/mail-vim-vault')`,
  )
  await until(
    `document.querySelector('[data-host-hints]')===null`,
    'hide revokes mail hint session',
  )
  assert.equal(
    await evaluate(
      `document.querySelector('iframe[aria-label="Message from Fixture"]')===window.__mailRetainedFrame`,
    ),
    true,
    'hiding the retained reader replaced its sandboxed document',
  )
  assert.equal(
    await evaluate(`window.__mailRetainedFrame.contentDocument.querySelector('details').open`),
    true,
    'hiding the reader collapsed its native disclosure',
  )
  const externalCallsBeforeStaleKey = await evaluate(
    `window.__mailVimCalls.filter(c=>c.op==='openExternal').length`,
  )
  for (const character of staleLinkKey) await key(character)
  assert.equal(
    await evaluate(`window.__mailVimCalls.filter(c=>c.op==='openExternal').length`),
    externalCallsBeforeStaleKey,
    'a hidden reader accepted a stale native hint',
  )
  await evaluate(
    `window.__mailVim.reader(true,'fixture-account-b','thread-b','synthetic/other-vault')`,
  )
  await until(
    `!document.querySelector('iframe[aria-label="Message from Fixture"]').closest('[hidden]')`,
    'reader shown in B context',
  )
  await evaluate(
    `window.__mailVim.reader(false,'fixture-account-a','thread-a','synthetic/mail-vim-vault')`,
  )
  await until(
    `document.querySelector('[data-host-hints]')===null`,
    'A-B-A reader ownership revoked',
  )
  await evaluate(
    `window.__mailVim.reader(true,'fixture-account-a','thread-a','synthetic/mail-vim-vault')`,
  )
  await click('button')
  await key('f')
  await until(
    `document.querySelector('[data-host-hints] [data-hint-key]')!==null`,
    'current A ownership discovers fresh native targets',
  )
  const currentLinkKey = await evaluate(
    `document.querySelector('[data-hint-target="Fixture external link"]')?.getAttribute('data-hint-key')`,
  )
  assert(currentLinkKey, 'fresh current-A mail link target is explicitly selected')
  const linkCallsBeforeInvalidation = await evaluate(
    `window.__mailVimCalls.filter(c=>c.op==='openExternal'&&c.account==='fixture-account-a'&&c.payload==='https://example.test/').length`,
  )
  const widthBeforeZoom = await evaluate('window.innerWidth')
  await evaluate(`console.log('HOLI_MAIL_SMOKE_ZOOM:1.2')`)
  await until(
    `window.innerWidth!==${widthBeforeZoom} && document.querySelector('[data-host-hints]')===null`,
    'native webContents zoom invalidates active mail hints',
  )
  for (const character of currentLinkKey) await key(character)
  assert.equal(
    await evaluate(
      `window.__mailVimCalls.filter(c=>c.op==='openExternal'&&c.payload==='https://example.test/').length`,
    ),
    linkCallsBeforeInvalidation,
    'resized viewport accepted a stale mail hint',
  )
  await evaluate(`console.log('HOLI_MAIL_SMOKE_ZOOM:1')`)
  await until(`window.innerWidth===${widthBeforeZoom}`, 'native webContents zoom reset')
  await click('button')
  await key('f')
  await until(
    `document.querySelector('[data-host-hints] [data-hint-key]')!==null`,
    'fresh targets after viewport reset',
  )
  const overlayStaleKey = await evaluate(
    `document.querySelector('[data-hint-key]').getAttribute('data-hint-key')`,
  )
  await evaluate(
    `window.__mailSmokeOverlay=document.createElement('div');Object.assign(window.__mailSmokeOverlay.style,{position:'fixed',inset:'0',zIndex:'9999',background:'transparent'});document.body.append(window.__mailSmokeOverlay)`,
  )
  await until(
    `document.querySelector('[data-host-hints]')===null`,
    'covering overlay invalidates native hints',
  )
  const callsBeforeOverlayKey = await evaluate(
    `window.__mailVimCalls.filter(c=>c.op==='openExternal').length`,
  )
  for (const character of overlayStaleKey) await key(character)
  assert.equal(
    await evaluate(`window.__mailVimCalls.filter(c=>c.op==='openExternal').length`),
    callsBeforeOverlayKey,
    'a covered native target still activated',
  )
  await evaluate(`window.__mailSmokeOverlay.remove()`)
  await click('button')
  await key('f')
  await until(
    `document.querySelector('[data-host-hints] [data-hint-key]')!==null`,
    'fresh targets after overlay removal',
  )
  const freshLinkKey = await evaluate(
    `document.querySelector('[data-hint-key]')?.getAttribute('data-hint-key')`,
  )
  assert(freshLinkKey, 'viewport reset exposes a current native target')
  for (const character of freshLinkKey) await key(character)
  await until(
    `window.__mailVimCalls.filter(c=>c.op==='openExternal'&&c.payload==='https://example.test/').length>${linkCallsBeforeInvalidation}`,
    'current A ownership activates a new native mail bridge call',
  )
  const activatedMailCall = await evaluate(
    `window.__mailVimCalls.filter(c=>c.op==='openExternal'&&c.payload==='https://example.test/').at(-1)`,
  )
  assert.equal(
    activatedMailCall.account,
    'fixture-account-a',
    'mail target uses its live account binding',
  )
  assert.equal(
    await evaluate(
      `window.__mailVimCalls.filter(c=>c.op==='openExternal'&&c.account==='fixture-account-a'&&c.payload==='https://example.test/').length`,
    ),
    linkCallsBeforeInvalidation + 1,
    'mail activation increments the correctly bound bridge counter exactly once',
  )
  await key('f')
  await until(
    `document.querySelector('[data-host-hints] [data-hint-target="Fixture external link"]')!==null`,
    'link target available before native removal',
  )
  const removedLinkKey = await evaluate(
    `document.querySelector('[data-hint-target="Fixture external link"]').getAttribute('data-hint-key')`,
  )
  const linksBeforeRemoval = await evaluate(
    `window.__mailVimCalls.filter(c=>c.op==='openExternal'&&c.payload==='https://example.test/').length`,
  )
  await evaluate(
    `document.querySelector('iframe[aria-label="Message from Fixture"]').contentDocument.querySelector('a[href="https://example.test/"]').remove()`,
  )
  await until(
    `document.querySelector('[data-host-hints]')===null`,
    'removed native link invalidates hints',
  )
  for (const character of removedLinkKey) await key(character)
  assert.equal(
    await evaluate(
      `window.__mailVimCalls.filter(c=>c.op==='openExternal'&&c.payload==='https://example.test/').length`,
    ),
    linksBeforeRemoval,
    'a removed native target still opened the external link',
  )
  await click('button')
  await key('f')
  await until(
    `document.querySelector('[data-host-hints]')!==null`,
    'mail hint session cancellation test',
  )
  await key('Escape')
  assert.equal(
    await evaluate(`document.querySelector('[data-host-hints]')===null`),
    true,
    'mail frame hint Escape did not cancel',
  )
  const cancelledScreenshot = await cdp('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
  })
  await writeFile(
    join(evidence, 'mail-document-hints-cancelled.png'),
    Buffer.from(cancelledScreenshot.data, 'base64'),
  )
  await evaluate(`document.documentElement.setAttribute('data-theme','light')`)
  await key('f')
  await until(
    `document.querySelector('[data-host-hints] [data-hint-target="Expand fixture details"]')!==null`,
    'light-theme owned mail-document hints',
  )
  const lightScreenshot = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(
    join(evidence, 'mail-document-hints-light.png'),
    Buffer.from(lightScreenshot.data, 'base64'),
  )
  await key('Escape')
  assert.deepEqual(
    await evaluate(`window.__mailVimErrors||[]`),
    [],
    'renderer errors occurred during native smoke',
  )
  const electronVersion = /HOLI_563_ELECTRON=([0-9.]+)/.exec(log)?.[1]
  assert.equal(electronVersion?.split('.')[0], '43', 'smoke must run under Electron 43')
  const allCalls = await evaluate(`JSON.stringify(window.__mailVimCalls)`).then(JSON.parse)
  const result = {
    ok: true,
    electron: electronVersion,
    checks: [
      'trusted-native-keyboard-and-mouse',
      'recipient-chip-and-payload-persistence',
      'subject-vim-undo',
      'preview-toggle-invalidates-pending-vim-operator',
      'draft-account-context-change-invalidates-pending-vim-command-without-remount',
      'discard-confirmation-cancels-without-discard',
      'insert-mode-f-does-not-open-host-hints',
      'normal-mode-f-opens-production-host-hints-and-escape-cancels',
      'owned-sandboxed-mail-targets-share-host-label-session-and-escape-cancel',
      'mail-reader-external-link-uses-host-bridge',
      'attachment-action-opens-provider-thread-without-mark-read-or-draft-side-effects',
      'real-disclosure-activation-preserves-native-details-behavior',
      'retained-reader-hide-revokes-hints-without-rewriting-disclosure-state',
      'account-vault-view-A-B-A-revokes-stale-reader-hints-and-current-hints-still-work',
      'viewport-zoom-revokes-stale-native-targets-before-current-operation',
      'covering-overlay-and-target-removal-revoke-native-actions',
      'normal-enter-does-not-commit-or-send-uncommitted-recipient',
      'cc-bcc-fields-validation-tab-backspace-and-enter',
      'renderer-error-free-and-no-blocked-network-requests',
      'disabled-vim-native-edit-and-blur-refocus-reset',
      'no-unintended-send-discard-close',
    ],
    captures: [
      'composer.png',
      'mail-document-hints.png',
      'mail-document-hints-light.png',
      'mail-document-hints-cancelled.png',
    ],
    disposableFiles: [disposableDraft],
    cleanup: { root, removed: true },
    calls: allCalls,
  }
  assert((await stat(join(evidence, 'composer.png'))).size > 0)
  child.kill('SIGTERM')
  const code = await Promise.race([
    closed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Electron native smoke timed out during shutdown')), 10000),
    ),
  ])
  assert.equal(code, 0)
  assert(!log.includes('Error occurred in handler'))
  assert.deepEqual(
    JSON.parse(await readFile(join(evidence, 'blocked-network-requests.json'), 'utf8')),
    [],
  )
  await rm(root, { recursive: true, force: true })
  await assert.rejects(stat(root), { code: 'ENOENT' })
  successResult = result
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.close()
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([closed, new Promise((r) => setTimeout(r, 3000))])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  await writeFile(join(evidence, 'electron-smoke.log'), log)
  await rm(root, { recursive: true, force: true })
  await writeFile(join(evidence, 'cleanup.json'), JSON.stringify({ removed: root }, null, 2))
}
await writeFile(join(evidence, 'result.json'), JSON.stringify(successResult, null, 2))
