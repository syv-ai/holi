import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, session, type WebContentsView } from 'electron'
import { browserMain } from '../src/plugins/browser/main/index'
import { createPluginHost, type OpenVault } from '../src/main/plugin-host/host'
import { createCapabilityRegistry } from '../src/main/capabilities/registry'
import { noCoreServices } from '../src/main/capabilities/services'
import type { MainPlugin } from '../src/main/plugin-api'
import type { PluginEvent } from '../src/main/plugin-host/events'
import type { PageInfo, PageRead } from '../src/plugins/browser/shared/page'

const root = process.env.HOLI_472_ROOT!
const evidence = process.env.HOLI_472_EVIDENCE!
assert(root && evidence)
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const rect = { x: 0, y: 0, width: 700, height: 450 }

async function run(): Promise<void> {
  for (const name of ['profile', 'session', 'vault-a', 'vault-b', 'app-data'])
    mkdirSync(join(root, name), { recursive: true })
  app.setName('Holi Browser Display QA 472')
  app.setPath('appData', join(root, 'app-data'))
  app.setPath('userData', join(root, 'profile'))
  app.setPath('sessionData', join(root, 'session'))
  assert.equal(app.getPath('userData'), join(root, 'profile'))
  await app.whenReady()
  const isolatedBrowserSession = session.fromPartition('persist:holi-browser')
  isolatedBrowserSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false
    try {
      const target = new URL(details.url)
      allowed = target.protocol === 'http:' && target.hostname === '127.0.0.1'
    } catch {
      allowed = false
    }
    callback({ cancel: !allowed })
  })
  const checks: string[] = []
  const mark = (name: string) => {
    checks.push(name)
    console.log(`PASS ${name}`)
  }
  let stallRequested!: () => void
  const stalled = new Promise<void>((resolve) => {
    stallRequested = resolve
  })
  const server = createServer((request, response) => {
    if (request.url === '/stall') {
      stallRequested()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><meta name="color-scheme" content="light dark"><style>body { color: CanvasText; background: Canvas; font: 16px sans-serif; }</style><title>Vault ${request.url === '/b' ? 'B' : 'A'} browser page</title>
      <main><h1>Browser page owned by vault ${request.url === '/b' ? 'B' : 'A'}</h1>
      <label>Search <input aria-label="Search" id="search"></label><button>Submit</button>
      <label>Text <input aria-label="Text" id="text" value="one two three"></label>
      <label>Lines <textarea aria-label="Lines" id="lines">first line\nsecond line</textarea></label>
      <label>Password <input aria-label="Password" type="password" id="password"></label>
      <label>Number <input aria-label="Number" type="number" id="number" value="12"></label>
      <label>Readonly <input aria-label="Readonly" id="readonly" value="locked" readonly></label>
      <label>Editable <div aria-label="Editable" id="editable" contenteditable="true">edit me</div></label>
      <label>Plain text <div aria-label="Plain text" id="plaintext" contenteditable="plaintext-only">café🙂 two</div></label>
      <label>Empty plain text <div aria-label="Empty plain text" id="plaintext-empty" contenteditable="plaintext-only"></div></label>
      <label>Not editable <div aria-label="Not editable" id="inert" contenteditable="false">inert</div></label>
      <label>Graphemes <textarea aria-label="Graphemes" id="graphemes">a café🙂 z</textarea></label>
      <label>Rows <textarea aria-label="Rows" id="rows">  alpha beta\n  gamma delta\n  omega</textarea></label>
      <div id="shadow-host"></div><iframe title="frame" srcdoc="<input id='frame-input' value='frame'>"></iframe>
      <p>Local fixture, no accounts</p></main><script>
      const shadow = document.querySelector('#shadow-host').attachShadow({mode:'open'});
      shadow.innerHTML = '<input id="shadow-input" value="shadow">';
      </script>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  const win = new BrowserWindow({
    width: 900,
    height: 650,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  await win.loadURL('data:text/html,<h1>Holi shell: no browser page attached</h1>')
  const roots = { A: join(root, 'vault-a'), B: join(root, 'vault-b') }
  for (const vault of Object.values(roots)) {
    mkdirSync(join(vault, '.holi/settings'), { recursive: true })
    writeFileSync(
      join(vault, '.holi/settings/plugins.yaml'),
      'plugins:\n  browser: true\n  delayed: false\n',
    )
  }
  const registry = createCapabilityRegistry()
  const listeners = new Set<(message: unknown) => void>()
  const sent: PluginEvent[] = []
  let gate: { wait: Promise<void>; entered(): void } | undefined
  let activationGate: { wait: Promise<void>; entered(): void } | undefined
  const delayed: MainPlugin = {
    info: { id: 'delayed', label: 'Delayed', default: false },
    async activate() {
      const pending = activationGate
      if (pending) {
        pending.entered()
        await pending.wait
      }
      return () => {}
    },
  }
  const host = createPluginHost({
    plugins: [browserMain, delayed],
    registry,
    userData: join(root, 'profile'),
    coreSeeds: [],
    active: () => null,
    rootFor: async (remote) => {
      const pending = gate
      if (pending) {
        pending.entered()
        await pending.wait
      }
      return roots[remote as keyof typeof roots] ?? null
    },
    events: {
      send: (_channel, event) => {
        sent.push(event)
      },
      listen: (_channel, handler) => {
        listeners.add(handler)
        return () => {
          listeners.delete(handler)
        }
      },
      liveRemote: () => host.displayed(),
    },
    openAppDoor: () => {
      throw new Error('no app door in browser smoke')
    },
    route: () => () => {},
    binDir: () => root,
    githubToken: () => null,
    frameOrigin: () => () => {},
    notify: () => false,
    focused: () => win.isFocused(),
    window: () => win,
  })
  const vault = (remote: keyof typeof roots): OpenVault => ({
    remote,
    root: roots[remote],
    pause: () => {},
    resume: () => {},
    commitNow: async () => null,
    repo: { head: async () => null },
  })
  const invoke = async <T>(remote: keyof typeof roots, name: string, params: unknown): Promise<T> =>
    (
      await registry.run(
        `browser.${name}`,
        'cli',
        {
          remote,
          root: roots[remote],
          bundle: null,
          core: noCoreServices(),
          claims: async () => [],
          snapshot: async () => {
            throw new Error('unused snapshot')
          },
        },
        params,
      )
    ).value as T
  const place = (remote: string, value: typeof rect | null, id = 'same') => {
    for (const listener of [...listeners])
      listener({ remote, name: 'place', payload: { id, rect: value } })
  }
  const child = () => win.contentView.children[0] as WebContentsView
  const block = () => {
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    gate = {
      wait: new Promise<void>((resolve) => {
        release = resolve
      }),
      entered,
    }
    return {
      waiting,
      release: () => {
        gate = undefined
        release()
      },
    }
  }
  const displayEvents = () => sent.filter((e) => ['reveal', 'address', 'key'].includes(e.name))
  const nativeKey = (view: WebContentsView, key: string) => {
    const input = {
      type: 'keyDown',
      key,
      code: `Key${key.toUpperCase()}`,
      meta: true,
      control: true,
      alt: false,
      shift: false,
    }
    // Existing display-isolation assertion exercises the callback on detached views.
    view.webContents.emit('before-input-event', { preventDefault() {} }, input)
  }
  const nativePress = async (
    view: WebContentsView,
    key: string,
    code?: string,
    shiftOverride?: boolean,
  ) => {
    const shift = shiftOverride ?? (key.length === 1 && key !== key.toLowerCase())
    const keyCode = code ?? (shift ? key.toLowerCase() : key)
    const modifiers = shift ? ['shift'] : []
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (key.length === 1) view.webContents.sendInputEvent({ type: 'char', keyCode: key, modifiers })
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  const inPage = <T>(view: WebContentsView, expression: string) =>
    view.webContents.executeJavaScript(expression) as Promise<T>
  host.setDisplayed('A')
  await host.reconcile(vault('A'), 'open')
  await host.reconcile(vault('B'), 'open')
  assert.deepEqual(host.failures('A'), {})
  assert.deepEqual(host.failures('B'), {})
  mark('production-host-and-browser-activations')
  await invoke<PageInfo>('A', 'open', { reopen: 'same', shown: true })
  place('A', rect)
  await tick()
  assert.equal(win.contentView.children.length, 1)
  const a = child()
  await invoke('A', 'open', { tab: 'same', url: `${url}/a` })
  const initial = await invoke<PageRead>('A', 'read', { tab: 'same' })
  assert.match(initial.text, /Browser page owned by vault A/)
  mark('displayed-page-attached-with-loaded-content')
  const capture = async (
    view: WebContentsView['webContents'],
    name: string,
    colorScheme?: 'light' | 'dark',
  ) => {
    // CDP requests a rendered frame even when the native test window is occluded.
    // No debugger port, visibility override or substitute renderer is involved.
    view.debugger.attach('1.3')
    try {
      await view.debugger.sendCommand('Page.enable')
      if (colorScheme !== undefined)
        await view.debugger.sendCommand('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: colorScheme }],
        })
      const image = (await view.debugger.sendCommand('Page.captureScreenshot', {
        captureBeyondViewport: true,
        fromSurface: true,
      })) as { data: string }
      assert(image.data.length > 0, `empty screenshot: ${name}`)
      writeFileSync(join(evidence, name), Buffer.from(image.data, 'base64'))
    } finally {
      view.debugger.detach()
    }
  }
  await capture(win.webContents, 'shell-before.png')
  await capture(a.webContents, 'browser-before.png', 'light')
  await capture(a.webContents, 'browser-dark.png', 'dark')
  const match = initial.text.match(/\[(\d+)\] textbox "Search"/)
  assert(match, initial.text)
  const ref = Number(match[1])
  const waitFor = async <T>(read: () => T | undefined, label: string): Promise<T> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = read()
      if (value !== undefined) return value
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  const selection = async (selector: string, start: number, end = start) =>
    inPage(a, `document.querySelector('${selector}').setSelectionRange(${start}, ${end})`)
  const vimSnapshot = await waitFor(
    () =>
      sent.find((event) => event.remote === 'A' && event.name === 'vim-mode')?.payload as
        | { id: string; nonce: string; attachment: string; revision: number; mode: string }
        | undefined,
    'production browser vim mode snapshot',
  )
  const configureVim = (snapshot: typeof vimSnapshot, enabled: boolean, revision: number) => {
    for (const listener of [...listeners])
      listener({
        remote: 'A',
        name: 'vim-config',
        payload: {
          id: 'same',
          enabled,
          revision,
          nonce: snapshot.nonce,
          attachment: snapshot.attachment,
        },
      })
  }
  const applyVimConfig = async (
    snapshot: typeof vimSnapshot,
    enabled: boolean,
    revision: number,
  ) => {
    const previous = sent.findLast((entry) => entry.remote === 'A' && entry.name === 'vim-mode')
      ?.payload as typeof vimSnapshot | undefined
    assert(previous, 'missing browser Vim configuration state')
    configureVim(snapshot, enabled, revision)
    await waitFor(() => {
      const event = sent.findLast((entry) => entry.remote === 'A' && entry.name === 'vim-mode')
      const current = event?.payload as typeof vimSnapshot | undefined
      // Main maps request revisions to its own monotonic document revision.
      return current?.nonce === snapshot.nonce &&
        current.attachment === snapshot.attachment &&
        current.revision > previous.revision
        ? current
        : undefined
    }, `browser Vim configuration revision ${revision}`)
  }
  await applyVimConfig(vimSnapshot, true, 1)
  await inPage(a, `document.querySelector('#text').focus()`)
  configureVim(vimSnapshot, false, 3)
  configureVim(vimSnapshot, true, 2)
  await nativePress(a, 'Escape')
  const staleConfigMode = await waitFor(() => {
    const event = sent.findLast((entry) => entry.remote === 'A' && entry.name === 'vim-mode')
    return (event?.payload as { mode?: string } | undefined)?.mode === 'insert' ? event : undefined
  }, 'stale config leaves browser Vim disabled')
  assert.equal((staleConfigMode.payload as { mode: string }).mode, 'insert')
  mark('stale-vim-disable-request-rejected')
  await applyVimConfig(vimSnapshot, true, 4)
  await inPage(a, `document.querySelector('#text').focus()`)
  await waitFor(
    () => sent.findLast((event) => event.remote === 'A' && event.name === 'vim-mode'),
    'configured browser vim mode',
  )
  await nativePress(a, 'Escape')
  const normalMode = await waitFor(() => {
    const event = sent.findLast((entry) => entry.remote === 'A' && entry.name === 'vim-mode')
    return (event?.payload as { mode?: string } | undefined)?.mode === 'normal' ? event : undefined
  }, 'normal mode after native Escape')
  assert.equal((normalMode.payload as { mode: string }).mode, 'normal')
  await selection('#text', 4)
  await nativePress(a, 'Right', 'Right', true)
  assert.deepEqual(
    await inPage<[number, number]>(
      a,
      `(() => { const e = document.querySelector('#text'); return [e.selectionStart, e.selectionEnd] })()`,
    ),
    [4, 5],
    'Shift+Right keeps native selection in Vim normal mode',
  )
  await selection('#text', 5)
  await nativePress(a, 'Home', undefined, true)
  assert.deepEqual(
    await inPage<[number, number]>(
      a,
      `(() => { const e = document.querySelector('#text'); return [e.selectionStart, e.selectionEnd] })()`,
    ),
    [0, 5],
    'Shift+Home keeps native selection in Vim normal mode',
  )
  await inPage(a, `document.querySelector('#rows').focus()`)
  await nativePress(a, 'Escape')
  await selection('#rows', 3)
  await nativePress(a, 'ArrowDown', 'Down', true)
  assert.deepEqual(
    await inPage<[number, number]>(
      a,
      `(() => { const e = document.querySelector('#rows'); return [e.selectionStart, e.selectionEnd] })()`,
    ),
    [3, 16],
    'Shift+Down keeps native multiline selection in Vim normal mode',
  )
  mark('native-shift-selection-preserved-in-vim-normal-mode')
  await inPage(a, `document.querySelector('#text').focus()`)
  await nativePress(a, 'Escape')
  const caret = async (selector: string) =>
    inPage<number>(a, `document.querySelector('${selector}').selectionStart`)
  await inPage(a, `document.querySelector('#text').focus()`)
  await selection('#text', 0)
  await nativePress(a, 'l')
  assert.equal(await caret('#text'), 1, 'l advances one grapheme')
  await nativePress(a, 'h')
  assert.equal(await caret('#text'), 0, 'h retreats one grapheme')
  await nativePress(a, 'w')
  assert.equal(await caret('#text'), 4, 'w advances to next word')
  await nativePress(a, 'b')
  assert.equal(await caret('#text'), 0, 'b retreats to prior word')
  await nativePress(a, 'e')
  assert.equal(await caret('#text'), 2, 'e advances to word end')
  await selection('#text', 4)
  await nativePress(a, 'a')
  assert.equal(await inPage<number>(a, `document.querySelector('#text').selectionStart`), 5)
  assert.equal(await inPage<string>(a, `document.querySelector('#text').value`), 'one two three')
  await nativePress(a, 'Escape')
  await selection('#text', 7)
  await nativePress(a, '0')
  assert.equal(await caret('#text'), 0, '0 moves to line start')
  await nativePress(a, '^')
  assert.equal(await caret('#text'), 0, '^ moves to first nonblank')
  await nativePress(a, '$')
  assert.equal(await caret('#text'), 13, '$ moves to line end')
  await selection('#text', 0)
  await nativePress(a, 'i')
  assert.equal(await caret('#text'), 0, 'i enters insert at cursor')
  await nativePress(a, 'Escape')
  await selection('#text', 0)
  await nativePress(a, 'a')
  assert.equal(await caret('#text'), 1, 'a enters insert after cursor')
  await nativePress(a, 'Escape')
  mark('native-h-l-w-b-e-0-caret-dollar-and-i-a')
  await inPage(a, `document.querySelector('#graphemes').focus()`)
  await nativePress(a, 'Escape')
  await selection('#graphemes', 0)
  await nativePress(a, 'l')
  assert.equal(await caret('#graphemes'), 1)
  await nativePress(a, 'l')
  assert.equal(await caret('#graphemes'), 2)
  await nativePress(a, 'l')
  assert.equal(await caret('#graphemes'), 3, 'combining grapheme is one step')
  await nativePress(a, 'l')
  assert.equal(await caret('#graphemes'), 4)
  await nativePress(a, 'l')
  assert.equal(await caret('#graphemes'), 5)
  await nativePress(a, 'l')
  assert.equal(await caret('#graphemes'), 7, 'combining mark is part of one grapheme')
  await nativePress(a, 'l')
  assert.equal(await caret('#graphemes'), 9, 'emoji grapheme is one step')
  await nativePress(a, 'h')
  assert.equal(await caret('#graphemes'), 7)
  mark('native-grapheme-safe-horizontal-motion')
  await inPage(a, `document.querySelector('#rows').focus()`)
  await nativePress(a, 'Escape')
  await selection('#rows', 3)
  await nativePress(a, 'j')
  assert.equal(await caret('#rows'), 16, 'j preserves grapheme column')
  await nativePress(a, 'j')
  assert.equal(await caret('#rows'), 30, 'j preserves the preferred column')
  await nativePress(a, 'k')
  assert.equal(await caret('#rows'), 16, 'k restores preferred column')
  mark('native-j-k-vertical-column')
  // The page's unsupported fields and foreign roots must receive native text
  // unchanged; only eligible top-document text fields enter insert/normal.
  for (const [selector, key, expected] of [
    ['#password', 'a', 'a'],
    ['#number', '1', '1'],
    ['#readonly', 'a', 'locked'],
    ['#inert', 'a', 'inert'],
    ['#editable', 'a', 'a'],
  ] as const) {
    await inPage(a, `document.querySelector('${selector}').focus()`)
    await nativePress(a, key)
    const value = await inPage<string>(
      a,
      `document.querySelector('${selector}').${selector === '#editable' || selector === '#inert' ? 'innerText' : 'value'}`,
    )
    assert(value.includes(expected), `${selector} passthrough: ${value}`)
  }
  await inPage(
    a,
    `document.querySelector('#shadow-host').shadowRoot.querySelector('input').focus()`,
  )
  await nativePress(a, 'a')
  assert.equal(
    await inPage<string>(
      a,
      `document.querySelector('#shadow-host').shadowRoot.querySelector('input').value`,
    ),
    'ashadow',
  )
  await inPage(a, `document.querySelector('iframe').contentDocument.querySelector('input').focus()`)
  await nativePress(a, 'a')
  assert.equal(
    await inPage<string>(
      a,
      `document.querySelector('iframe').contentDocument.querySelector('input').value`,
    ),
    'aframe',
  )
  mark('unsupported-password-number-readonly-contenteditable-shadow-frame-passthrough')
  const setPlainSelection = (selector: string, offset = 0) =>
    inPage(
      a,
      `(() => { const host = document.querySelector('${selector}'); host.focus(); const range = document.createRange(); const node = host.firstChild; if (node) range.setStart(node, Math.min(${offset}, node.length)); else range.setStart(host, 0); range.collapse(true); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range) })()`,
    )
  await setPlainSelection('#plaintext')
  await nativePress(a, 'Escape')
  await nativePress(a, 'w')
  assert.equal(
    await inPage<number>(
      a,
      `(() => { const s = getSelection(); return s.anchorNode === document.querySelector('#plaintext').firstChild ? s.anchorOffset : s.anchorNode.textContent.length + s.anchorOffset })()`,
    ),
    8,
    'plaintext-only w uses the native caret across plain text',
  )
  await nativePress(a, 'i')
  await nativePress(a, 'Z')
  const plainAfterInsert = await inPage<string>(
    a,
    `document.querySelector('#plaintext').textContent`,
  )
  assert.equal(plainAfterInsert, 'café🙂 Ztwo')
  a.webContents.undo()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(
    await inPage<string>(a, `document.querySelector('#plaintext').textContent`),
    'café🙂 two',
  )
  a.webContents.redo()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(
    await inPage<string>(a, `document.querySelector('#plaintext').textContent`),
    plainAfterInsert,
  )
  mark('native-plaintext-only-motion-insert-and-native-undo-redo')
  await setPlainSelection('#plaintext')
  await nativePress(a, 'Escape')
  if (!a.webContents.debugger.isAttached()) a.webContents.debugger.attach('1.3')
  await a.webContents.debugger.sendCommand('Input.imeSetComposition', {
    text: '日本語',
    selectionStart: 3,
    selectionEnd: 3,
  })
  await a.webContents.debugger.sendCommand('Input.insertText', { text: '日本語' })
  assert(
    (await inPage<string>(a, `document.querySelector('#plaintext').textContent`)).includes(
      '日本語',
    ),
  )
  mark('native-plaintext-ime-composition-remains-native')
  await inPage(a, `document.querySelector('#plaintext').textContent='café🙂 two'`)

  await setPlainSelection('#plaintext')
  await nativePress(a, 'Escape')
  await setPlainSelection('#plaintext')
  await inPage(
    a,
    `(() => { const host = document.querySelector('#plaintext'); host.setAttribute('contenteditable','true'); host.setAttribute('contenteditable','plaintext-only') })()`,
  )
  const shapeBefore = await inPage<string>(a, `document.querySelector('#plaintext').textContent`)
  await nativePress(a, 'h')
  assert.notEqual(
    await inPage<string>(a, `document.querySelector('#plaintext').textContent`),
    shapeBefore,
  )
  mark('plaintext-shape-loss-and-restoration-invalidates-normal-ownership')

  await applyVimConfig(vimSnapshot, false, 5)
  await setPlainSelection('#plaintext')
  const disabledPlain = await inPage<string>(a, `document.querySelector('#plaintext').textContent`)
  await nativePress(a, 'q')
  assert.notEqual(
    await inPage<string>(a, `document.querySelector('#plaintext').textContent`),
    disabledPlain,
  )
  await applyVimConfig(vimSnapshot, true, 6)
  await setPlainSelection('#plaintext')
  await nativePress(a, 'Escape')
  mark('plaintext-live-preference-off-passes-native-typing')

  await setPlainSelection('#plaintext')
  await nativePress(a, 'Escape')
  await setPlainSelection('#plaintext')
  const outsideRange = await inPage(
    a,
    `(() => { const host = document.querySelector('#search'); host.focus(); host.setSelectionRange(0,0); const range = document.createRange(); range.selectNodeContents(host); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range) })()`,
  )
  void outsideRange
  const outsideBefore = await inPage<string>(a, `document.querySelector('#plaintext').textContent`)
  await nativePress(a, 'Escape')
  assert.equal(
    await inPage<string>(a, `document.querySelector('#plaintext').textContent`),
    outsideBefore,
  )
  await setPlainSelection('#plaintext')
  await new Promise((resolve) => setTimeout(resolve, 40))
  const plainMode = await a.webContents.executeJavaScriptInIsolatedWorld(1017, [
    { code: `__holiPage.vim.mode().mode` },
  ])
  assert.equal(plainMode, 'insert')
  mark('plaintext-outside-selection-escape-passthrough-and-reset')

  await setPlainSelection('#plaintext-empty')
  await nativePress(a, 'Escape')
  assert.equal(
    await inPage<string>(a, `document.querySelector('#plaintext-empty').textContent`),
    '',
  )
  await inPage(
    a,
    `document.querySelector('#plaintext-empty').setAttribute('contenteditable','true')`,
  )
  await nativePress(a, 'a')
  assert.equal(
    await inPage<string>(a, `document.querySelector('#plaintext-empty').textContent`),
    'a',
  )
  mark('native-empty-host-and-contenteditable-disable-passthrough')
  await inPage(a, `document.querySelector('#text').focus()`)
  await nativePress(a, 'Escape')
  await nativePress(a, 'Escape')
  assert.equal(await inPage<string>(a, `document.querySelector('#text').value`), 'one two three')
  if (!a.webContents.debugger.isAttached()) a.webContents.debugger.attach('1.3')
  try {
    await a.webContents.debugger.sendCommand('Input.imeSetComposition', {
      text: '日本語',
      selectionStart: 3,
      selectionEnd: 3,
    })
    await a.webContents.debugger.sendCommand('Input.insertText', { text: '日本語' })
  } finally {
    a.webContents.debugger.detach()
  }
  assert((await inPage<string>(a, `document.querySelector('#text').value`)).includes('日本語'))
  mark('native-ime-composition-in-insert-mode')
  await inPage(a, `document.querySelector('#text').value = 'one two three'`)
  await applyVimConfig(vimSnapshot, false, 7)
  await inPage(
    a,
    `document.querySelector('#text').focus(); document.querySelector('#text').setSelectionRange(0, 0)`,
  )
  await nativePress(a, 'z')
  assert.equal(
    await inPage<string>(a, `document.querySelector('#text').value`),
    'zone two three',
    'disabled preference passes input through',
  )
  await applyVimConfig(vimSnapshot, true, 8)
  await inPage(a, `document.querySelector('#text').focus()`)
  await nativePress(a, 'Escape')
  const reenabledMode = await waitFor(() => {
    const event = sent.findLast((entry) => entry.remote === 'A' && entry.name === 'vim-mode')
    return (event?.payload as { mode?: string } | undefined)?.mode === 'normal' ? event : undefined
  }, 'Vim mode after preference re-enable')
  assert.equal((reenabledMode.payload as { mode: string }).mode, 'normal')
  mark('preference-disable-reenable-controls-native-vim')
  await inPage(a, `document.querySelector('#text').value = 'one two three'`)
  await inPage(
    a,
    `document.querySelector('#search').value = 'kept'; document.querySelector('#search').focus()`,
  )
  await nativePress(a, 'Escape')
  await nativePress(a, 'Escape')
  assert.equal(await inPage<string>(a, `document.querySelector('#search').value`), 'kept')
  mark('native-normal-escape-preserves-search-value')
  await inPage(
    a,
    `document.querySelector('#lines').value = '\\n  café🙂'; document.querySelector('#lines').focus()`,
  )
  await nativePress(a, 'Escape')
  await inPage(a, `document.querySelector('#lines').setSelectionRange(1, 1)`)
  await nativePress(a, 'k')
  assert.equal(await inPage<number>(a, `document.querySelector('#lines').selectionStart`), 0)
  await nativePress(a, '0')
  assert.equal(await inPage<number>(a, `document.querySelector('#lines').selectionStart`), 0)
  mark('native-leading-newline-line-start')
  await inPage(
    a,
    `document.querySelector('#text').setSelectionRange(0, 0); document.querySelector('#text').focus()`,
  )
  await nativePress(a, 'Escape')
  await inPage(a, `document.querySelector('#text').setSelectionRange(0, 0)`)
  const beforeNormalText = await inPage<string>(a, `document.querySelector('#text').value`)
  await nativePress(a, 'w')
  assert.equal(await inPage<number>(a, `document.querySelector('#text').selectionStart`), 4)
  await nativePress(a, 'e')
  assert.equal(await inPage<number>(a, `document.querySelector('#text').selectionStart`), 6)
  await nativePress(a, 'e')
  assert.equal(await inPage<number>(a, `document.querySelector('#text').selectionStart`), 12)
  await inPage(a, `document.querySelector('#text').setSelectionRange(4, 4)`)
  await nativePress(a, 'x')
  assert.equal(await inPage<string>(a, `document.querySelector('#text').value`), beforeNormalText)
  await nativePress(a, 'i')
  await inPage(
    a,
    `window.nativeInputEvents = 0; document.querySelector('#text').addEventListener('input', () => window.nativeInputEvents++)`,
  )
  await nativePress(a, 'X')
  assert.equal(await inPage<string>(a, `document.querySelector('#text').value`), 'one Xtwo three')
  assert.equal(
    await inPage<number>(a, `window.nativeInputEvents`),
    1,
    'native insert emits one input event',
  )
  a.webContents.undo()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(await inPage<string>(a, `document.querySelector('#text').value`), beforeNormalText)
  a.webContents.redo()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(await inPage<string>(a, `document.querySelector('#text').value`), 'one Xtwo three')
  mark('native-browser-vim-mode-navigation-insertion-undo-redo')
  await inPage(
    a,
    `document.querySelector('#text').value = 'one two three'; document.querySelector('#text').focus()`,
  )
  const beforeSameDocument = sent.findLast(
    (event) => event.remote === 'A' && event.name === 'vim-mode',
  )!.payload as typeof vimSnapshot
  await nativePress(a, 'Escape')
  await inPage(a, `history.pushState({ smoke: true }, '', '#same-document')`)
  const afterSameDocument = await waitFor(() => {
    const event = sent.findLast((entry) => entry.remote === 'A' && entry.name === 'vim-mode')
    const snapshot = event?.payload as typeof vimSnapshot | undefined
    return snapshot && snapshot.nonce !== beforeSameDocument.nonce ? snapshot : undefined
  }, 'Vim ownership reset after same-document navigation')
  assert.equal(afterSameDocument.mode, 'insert')
  await applyVimConfig(afterSameDocument, true, 1)
  await inPage(a, `document.querySelector('#text').focus()`)
  await selection('#text', 0)
  await nativePress(a, 'z')
  assert.equal(await inPage<string>(a, `document.querySelector('#text').value`), 'zone two three')
  mark('native-same-document-navigation-rearms-insert-mode')

  await inPage(
    a,
    `document.querySelector('#text').value = 'one two three'; document.querySelector('#text').focus()`,
  )
  await nativePress(a, 'Escape')
  await nativePress(a, 'w')
  const beforeAbortedNavigation = sent.findLast(
    (event) => event.remote === 'A' && event.name === 'vim-mode',
  )!.payload as typeof vimSnapshot
  const stalledNavigation = invoke<PageInfo>('A', 'open', { tab: 'same', url: `${url}/stall` })
  await stalled
  a.webContents.stop()
  await stalledNavigation
  const recoveredDocument = await waitFor(() => {
    const event = sent.findLast((entry) => entry.remote === 'A' && entry.name === 'vim-mode')
    const snapshot = event?.payload as typeof vimSnapshot | undefined
    return snapshot && snapshot.nonce !== beforeAbortedNavigation.nonce ? snapshot : undefined
  }, 'Vim ownership recovery after aborted navigation')
  await applyVimConfig(recoveredDocument, false, 1)
  await selection('#text', 0)
  await nativePress(a, 'z')
  assert.equal(
    await inPage<string>(a, `document.querySelector('#text').value`),
    'zone two three',
    'aborted navigation recovery lets the surviving document accept disabled Vim input',
  )
  mark('native-aborted-navigation-recovers-surviving-document-configuration')

  place('A', null)
  place('A', rect)
  const reattachedVim = await waitFor(() => {
    const event = sent.findLast((entry) => entry.remote === 'A' && entry.name === 'vim-mode')
    const snapshot = event?.payload as typeof vimSnapshot | undefined
    return snapshot && snapshot.attachment !== vimSnapshot.attachment ? snapshot : undefined
  }, 'fresh attachment Vim snapshot')
  await applyVimConfig(reattachedVim, true, 1)
  await inPage(a, `document.querySelector('#text').focus()`)
  await nativePress(a, 'Escape')
  const reattachedMode = await waitFor(() => {
    const event = sent.findLast((entry) => entry.remote === 'A' && entry.name === 'vim-mode')
    return (event?.payload as { mode?: string } | undefined)?.mode === 'normal' ? event : undefined
  }, 'Vim rearmed after fresh attachment')
  assert.equal((reattachedMode.payload as { mode: string }).mode, 'normal')
  mark('vim-rearms-after-native-reattachment')
  nativeKey(a, 'l')
  await tick()
  assert(
    displayEvents().some((e) => e.name === 'address'),
    'positive native input control',
  )
  sent.length = 0
  const staleKey = block()
  nativeKey(a, 'w')
  await staleKey.waiting
  place('A', null)
  staleKey.release()
  await tick()
  assert.equal(displayEvents().length, 0, 'hidden attachment rejects queued shortcut')
  mark('queued-native-action-expires-on-tab-hide')
  place('A', rect)
  await tick()
  const staleDisplay = block()
  nativeKey(a, 'w')
  await staleDisplay.waiting
  host.setDisplayed('B')
  assert.equal(win.contentView.children.length, 0)
  host.setDisplayed('A')
  staleDisplay.release()
  await tick()
  assert.equal(displayEvents().length, 0)
  assert.equal(win.contentView.children.length, 0)
  mark('departure-detaches-synchronously')
  mark('queued-action-expires-across-return')
  host.setDisplayed(null)
  assert.equal(win.contentView.children.length, 0)
  const focus = win.webContents.isFocused()
  await invoke('A', 'type', { tab: 'same', ref, text: 'hidden-value' })
  await invoke('A', 'press', { tab: 'same', key: 'Enter' })
  assert.match((await invoke<PageRead>('A', 'read', { tab: 'same' })).text, /hidden-value/)
  nativeKey(a, 'l')
  nativeKey(a, 'w')
  place('A', rect)
  await tick()
  assert.equal(displayEvents().length, 0)
  assert.equal(win.contentView.children.length, 0)
  assert.equal(win.webContents.isFocused(), focus)
  mark('hidden-authorized-page-read-type-and-press-work')
  mark('hidden-native-input-and-placement-are-inert')
  await a.webContents.executeJavaScript('window.open("/popup"); true')
  const hiddenTabs = await invoke<PageInfo[]>('A', 'tabs', {})
  assert.equal(hiddenTabs.length, 2, 'hidden popup remains bound to its originating activation')
  await tick()
  assert.equal(displayEvents().length, 0)
  assert.equal(win.contentView.children.length, 0)
  const popupId = hiddenTabs.find((page) => page.id !== 'same')!.id
  assert.match((await invoke<PageRead>('A', 'read', { tab: popupId })).text, /vault A/)
  await invoke('A', 'close', { tab: popupId })
  mark('hidden-popup-keeps-data-without-presentation')
  await capture(win.webContents, 'browser-after.png')
  host.setDisplayed('B')
  await invoke('B', 'open', { reopen: 'same', url: `${url}/b`, shown: true })
  place('B', rect)
  await tick()
  const b = child()
  assert(b && b !== a)
  mark('duplicate-page-ids-have-distinct-native-views')
  host.setDisplayed('A')
  assert.equal(win.contentView.children.length, 0)
  place('A', rect)
  await tick()
  assert.equal(child(), a)
  mark('return-requires-fresh-owner-placement')
  const oldPlace = block()
  place('A', rect)
  await oldPlace.waiting
  await invoke('A', 'close', { tab: 'same' })
  await invoke('A', 'open', { reopen: 'same', url: `${url}/a`, shown: true })
  oldPlace.release()
  await tick()
  assert.equal(win.contentView.children.length, 0)
  place('A', rect)
  await tick()
  assert(child() && child() !== a)
  mark('same-id-reincarnation-rejects-stale-placement')
  host.setDisplayed('B')
  place('B', rect)
  await tick()
  await host.stop('A')
  assert.equal(child(), b)
  assert.match((await invoke<PageRead>('B', 'read', { tab: 'same' })).text, /vault B/)
  mark('stopping-a-preserves-b-native-view-and-capabilities')
  host.setDisplayed(null)
  assert.equal(win.contentView.children.length, 0)
  mark('departure-to-null-removes-replacement')
  // Reconcile can hold disposal behind plugin activation. Display departure must
  // detach the native child before that activation is released, for both stop APIs.
  for (const [index, [stop, target, check]] of [
    [() => host.stop('A'), 'B', 'pending-reconcile-stop-detaches-to-b'],
    [() => host.stop('A'), null, 'pending-reconcile-stop-detaches-to-null'],
    [() => host.stopAll(), 'B', 'pending-reconcile-stop-all-detaches-to-b'],
    [() => host.stopAll(), null, 'pending-reconcile-stop-all-detaches-to-null'],
  ].entries()) {
    if (index > 0) {
      writeFileSync(
        join(roots.A, '.holi/settings/plugins.yaml'),
        'plugins:\n  browser: true\n  delayed: false\n',
      )
      await host.reconcile(vault('A'), 'settings')
    }
    await host.reconcile(vault('A'), 'open')
    host.setDisplayed('A')
    await invoke('A', 'open', { reopen: 'same', url: `${url}/a`, shown: true })
    place('A', rect)
    await tick()
    assert.equal(win.contentView.children.length, 1)
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    activationGate = {
      wait: new Promise<void>((resolve) => {
        release = resolve
      }),
      entered,
    }
    writeFileSync(
      join(roots.A, '.holi/settings/plugins.yaml'),
      'plugins:\n  browser: true\n  delayed: true\n',
    )
    const reconciling = host.reconcile(vault('A'), 'settings')
    await waiting
    const stopping = stop()
    host.setDisplayed(target)
    assert.equal(win.contentView.children.length, 0, 'stopping owner detaches synchronously')
    host.setDisplayed('A')
    place('A', rect)
    await tick()
    assert.equal(win.contentView.children.length, 0, 'stopping owner cannot reattach on return')
    host.setDisplayed(target)
    activationGate = undefined
    release()
    await Promise.all([reconciling, stopping])
    mark(check)
  }
  // The toolbar acceptance runner inserts its isolated renderer phase before teardown.
  assert.equal(listeners.size, 0)
  win.destroy()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  writeFileSync(
    join(evidence, 'result.json'),
    JSON.stringify(
      {
        ok: true,
        checks,
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
        roots: {
          app: root,
          profile: join(root, 'profile'),
          session: join(root, 'session'),
          vaultA: roots.A,
          vaultB: roots.B,
        },
        screenshots: [
          'browser-before.png',
          'browser-dark.png',
          'shell-before.png',
          'browser-after.png',
        ],
      },
      null,
      2,
    ),
  )
  app.quit()
}

void run().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
