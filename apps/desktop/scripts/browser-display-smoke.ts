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
import { runAppFrameSmoke } from './app-frame-smoke'

const root = process.env.HOLI_473_ROOT!
const evidence = process.env.HOLI_473_EVIDENCE!
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
  if (process.env.HOLI_509_APP_HINTS_ONLY === '1') {
    const checks = await runAppFrameSmoke(root, evidence)
    writeFileSync(
      join(evidence, 'result.json'),
      JSON.stringify(
        {
          ok: true,
          electron: process.versions.electron,
          checks,
          roots: {
            profile: join(root, 'profile'),
            vaultA: join(root, 'vault-a'),
            vaultB: join(root, 'vault-b'),
          },
          source: process.env.HOLI_553_SHA,
          worktree: process.env.HOLI_553_WORKTREE,
          worktreeStatus: process.env.HOLI_553_STATUS,
          screenshots: [
            'vault-app-a.png',
            'vault-app-b.png',
            'app-frame-read-a.png',
            'app-frame-read-b.png',
            'app-hints-light.png',
            'app-hints-dark.png',
          ],
        },
        null,
        2,
      ),
    )
    app.exit(0)
    return
  }
  const isolatedBrowserSession = session.fromPartition('persist:holi-browser')
  isolatedBrowserSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false
    try {
      const target = new URL(details.url)
      const owned = server.address()
      allowed =
        target.protocol === 'http:' &&
        (target.hostname === '127.0.0.1' ||
          (process.env.HOLI_671_CHILD_VIM === '1' &&
            target.hostname === 'localhost' &&
            owned !== null &&
            typeof owned === 'object' &&
            target.port === String(owned.port)))
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
    if (process.env.HOLI_671_CHILD_VIM === '1' && request.url?.startsWith('/671-')) {
      const address = server.address()
      assert(address && typeof address === 'object')
      const cross = `http://localhost:${address.port}/671-cross`
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self' http://localhost:${address.port}`,
      })
      response.end(`<!doctype html><meta name="color-scheme" content="light dark"><style>body{color:CanvasText;background:Canvas;font:16px sans-serif}iframe{width:250px;height:100px}</style><label>Owned child field <input id="child-field" value="one two"></label>
        ${request.url === '/671-parent' ? `<iframe name="duplicate" src="${cross}"></iframe><iframe name="duplicate" src="${cross}"></iframe>` : ''}
        <script>window.nativeEvents=[];for(const type of ['keydown','input'])document.addEventListener(type,e=>window.nativeEvents.push({type,key:e.key,trusted:e.isTrusted,value:e.target.value}),true)</script>`)
      return
    }
    if (request.url === '/stall') {
      stallRequested()
      return
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'",
    })
    response.end(`<!doctype html><meta name="color-scheme" content="light dark"><style>body { color: CanvasText; background: Canvas; font: 16px sans-serif; }</style><title>Vault ${request.url === '/b' ? 'B' : 'A'} browser page</title>
      <main><h1>Browser page owned by vault ${request.url === '/b' ? 'B' : 'A'}</h1>
      <label>Search <input aria-label="Search" id="search"></label><label><input id="trusted-check" type="checkbox" aria-label="Accept terms">Accept terms</label><button role="switch" aria-label="Alerts">Alerts</button><button id="trusted-button">Submit</button><a id="trusted-link" href="#clicked">Trusted link</a>
      <button style="opacity:0">Transparent exclusion</button><div style="opacity:0"><button>Ancestor transparent exclusion</button></div>
      <div inert><button>Inert exclusion</button></div><div aria-hidden="true"><button>Aria hidden exclusion</button></div>
      <button id="disabled-hint" disabled>Disabled exclusion</button><button id="hidden-hint" hidden>Hidden exclusion</button>
      <div style="position:relative"><button>Occluded exclusion</button><span style="position:absolute;inset:0;z-index:1"></span></div>
      <div style="width:1px;height:1px;overflow:hidden"><button style="margin-left:50px">Clipped exclusion</button></div>
      <div id="hint-targets">${Array.from({ length: 30 }, (_, index) => `<button type="button">Target ${index + 1}</button>`).join('')}</div>
      <label>Text <input aria-label="Text" id="text" value="one two three"></label>
      <label>Lines <textarea aria-label="Lines" id="lines">first line\nsecond line</textarea></label>
      <label>Password <input aria-label="Password" type="password" id="password"></label>
      <label>Number <input aria-label="Number" type="number" id="number" value="12"></label>
      <label>Readonly <input aria-label="Readonly" id="readonly" value="locked" readonly></label>
      <label>Editable <div aria-label="Editable" id="editable" contenteditable="true">edit me</div></label>
      <label>Plain text <div aria-label="Plain text" id="plaintext" contenteditable="plaintext-only">café🙂 two</div></label>
      <label>Rich text <div aria-label="Rich text" id="rich" contenteditable="true" style="border:1px solid currentColor;padding:8px"><strong>bold</strong> <a href="/next">café🙂 link</a><em></em></div></label>
      <label>Multiline rich text <div aria-label="Multiline rich text" id="multiline" contenteditable="true" style="border:1px solid currentColor;padding:8px"><p>first <strong>bold</strong></p><p><br></p><div>third <a href="/next">linked</a></div></div></label>
      <label>Empty plain text <div aria-label="Empty plain text" id="plaintext-empty" contenteditable="plaintext-only"></div></label>
      <label>Block-shaped rich host <div id="rich-block" contenteditable="true" style="display:block"><span style="display:block">one</span><span style="display:block">two</span></div></label>
      <label>Atomic rich host <div id="rich-atom" contenteditable="true">one<img src="data:," alt="atom">two</div></label>
      <label>Nested rich host <div id="rich-nested" contenteditable="true"><span contenteditable="true">nested</span></div></label>
      <label>Inert rich descendant <div id="rich-inert" contenteditable="true"><strong>one </strong><span inert>skip</span> two</div></label>
      <label>Not editable <div aria-label="Not editable" id="inert" contenteditable="false">inert</div></label>
      <label>Graphemes <textarea aria-label="Graphemes" id="graphemes">a café🙂 z</textarea></label>
      <label>Rows <textarea aria-label="Rows" id="rows">  alpha beta\n  gamma delta\n  omega</textarea></label>
      <div id="shadow-host"></div><iframe title="frame" srcdoc="<input id='frame-input' value='frame'>"></iframe>
      <p>Local fixture, no accounts</p><div aria-hidden="true" style="height:1200px"></div></main><script>
      const shadow = document.querySelector('#shadow-host').attachShadow({mode:'open'});
      shadow.innerHTML = '<input id="shadow-input" value="shadow">';
      </script>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const nativeRequests: { webContentsId: number; processId: number; routingId: number }[] = []
  // This is Electron 43's native provenance seam: protocol Request itself
  // does not expose a webContentsId, while webRequest details do.
  const defaultSession = (await import('electron')).session.defaultSession
  defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith('http://127.0.0.1:')) {
      nativeRequests.push({
        webContentsId: details.webContentsId,
        processId: details.frame.processId,
        routingId: details.frame.routingId,
      })
    }
    callback({})
  })
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
  await win.loadURL(`${url}/a`)
  assert(
    nativeRequests.some(
      (request) =>
        request.webContentsId === win.webContents.id &&
        Number.isInteger(request.processId) &&
        Number.isInteger(request.routingId),
    ),
    'Electron webRequest did not expose exact native requester and frame provenance',
  )
  mark('electron43-webrequest-native-window-and-frame-provenance')
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
  const reportFrames = new WeakMap<object, object | null>()
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
        if (process.env.HOLI_671_CHILD_VIM === '1' && event.name === 'vim-mode') {
          const shown = win.contentView.children[0] as WebContentsView | undefined
          reportFrames.set(event, shown?.webContents.focusedFrame ?? null)
        }
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
    drainSync: async () => {},
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
    const caretTarget = await inPage<boolean>(
      view,
      `document.activeElement?.matches('#text, #graphemes') ?? false`,
    )
    const expectedKey =
      (
        { Right: 'ArrowRight', Left: 'ArrowLeft', Up: 'ArrowUp', Down: 'ArrowDown' } as Record<
          string,
          string
        >
      )[key] ?? key
    const pageKey = JSON.stringify(expectedKey)
    const eventStart = await inPage<number>(view, `window.__holiSmokeNativeEvents?.length ?? 0`)
    const nativeInput = [
      { type: 'keyDown', keyCode, modifiers },
      ...(key.length === 1 ? [{ type: 'char', keyCode: key, modifiers }] : []),
      { type: 'keyUp', keyCode, modifiers },
    ] as const
    for (const input of nativeInput) view.webContents.sendInputEvent(input)
    if (!caretTarget) {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const acknowledged = await inPage<boolean>(
        view,
        `window.__holiSmokeNativeEvents?.slice(${eventStart}).some(event => event.type === 'keyup' && event.key === ${pageKey} && event.trusted) ?? false`,
      )
      if (acknowledged) {
        const target = await inPage<string | null>(
          view,
          `document.activeElement?.matches('#text, #graphemes') ? document.activeElement.id : null`,
        )
        if (target) return
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const diagnostic = await inPage<unknown>(
      view,
      `({key:${pageKey},active:document.activeElement?.id,events:window.__holiSmokeNativeEvents?.slice(${eventStart}) ?? []})`,
    )
    throw new Error(`native keyup was not observed: ${JSON.stringify(diagnostic)}`)
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
    if (view.debugger.isAttached()) {
      const { nativeTheme } = await import('electron')
      const previous = nativeTheme.themeSource
      try {
        if (colorScheme) nativeTheme.themeSource = colorScheme
        const image = await view.capturePage()
        assert(!image.isEmpty(), `empty screenshot: ${name}`)
        writeFileSync(join(evidence, name), image.toPNG())
      } finally {
        nativeTheme.themeSource = previous
      }
      return
    }
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
  await inPage(
    a,
    `(() => { window.__holiSmokeNativeEvents=[]; for (const type of ['keydown','beforeinput','input','keyup']) document.addEventListener(type,event => { const target=event.target; window.__holiSmokeNativeEvents.push({type,key:event.key,inputType:event.inputType ?? null,data:event.data ?? null,trusted:event.isTrusted,target:target?.id ?? null,value:target?.value ?? null,selection:target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? [target.selectionStart,target.selectionEnd] : null}) },true) })()`,
  )
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
  if (process.env.HOLI_671_CHILD_VIM === '1') {
    const original = await inPage<string>(a, `document.querySelector('iframe').srcdoc`)
    await inPage(
      a,
      `document.querySelector('iframe').srcdoc = '<input id="child-field" value="one two">'`,
    )
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await inPage<boolean>(
          a,
          `!!document.querySelector('iframe').contentDocument?.querySelector('#child-field')`,
        )
      )
        break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    a.webContents.focus()
    const beforeChildFocus = sent.findLast(
      (entry) => entry.remote === 'A' && entry.name === 'vim-mode',
    )
    await inPage(
      a,
      `(() => { const frame = document.querySelector('iframe'); frame.scrollIntoView({block:'center'}); const field = frame.contentDocument.querySelector('#child-field'); field.focus(); field.setSelectionRange(4,4) })()`,
    )
    const childInsertMode = await waitFor(() => {
      const event = sent.findLast((entry) => entry.remote === 'A' && entry.name === 'vim-mode')
      const mode = event?.payload as { mode?: string } | undefined
      return event !== beforeChildFocus &&
        mode?.mode === 'insert' &&
        event &&
        reportFrames.get(event) === a.webContents.focusedFrame
        ? event
        : undefined
    }, 'fresh insert-mode report after native child-frame focus')
    assert.equal((childInsertMode.payload as { mode: string }).mode, 'insert')
    const childPress = async (key: string) => {
      // Electron sendInputEvent targets the root widget. CDP's native keyboard
      // dispatch follows the browser's focused widget, including an OOPIF.
      assert(a.webContents.debugger.isAttached(), 'child readiness owns the debugger')
      const printable = key.length === 1
      const code = printable ? `Key${key.toUpperCase()}` : key
      const windowsVirtualKeyCode = printable ? key.toUpperCase().charCodeAt(0) : 27
      await a.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: printable ? 'keyDown' : 'rawKeyDown',
        key,
        code,
        windowsVirtualKeyCode,
        ...(printable ? { text: key, unmodifiedText: key } : {}),
      })
      await a.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code,
        windowsVirtualKeyCode,
      })
    }
    await childPress('Escape')
    await waitFor(() => {
      const event = sent.findLast((entry) => entry.remote === 'A' && entry.name === 'vim-mode')
      return (event?.payload as { mode?: string } | undefined)?.mode === 'normal'
        ? event
        : undefined
    }, 'child normal mode after trusted Escape')
    await childPress('h')
    assert.equal(
      await inPage<number>(
        a,
        `document.querySelector('iframe').contentDocument.querySelector('#child-field').selectionStart`,
      ),
      3,
    )
    await childPress('l')
    await childPress('i')
    await childPress('x')
    assert.equal(
      await inPage<string>(
        a,
        `document.querySelector('iframe').contentDocument.querySelector('#child-field').value`,
      ),
      'one xtwo',
    )
    mark('native-child-vim-same-origin-frame-insert-report')
    await inPage(
      a,
      `document.querySelector('iframe').removeAttribute('srcdoc'); document.querySelector('iframe').src = ${JSON.stringify(`${url}/671-parent`)}`,
    )
    let mixed = a.webContents.mainFrame.framesInSubtree.filter(
      (frame) => frame.url === `http://localhost:${address.port}/671-cross`,
    )
    for (let attempt = 0; attempt < 200 && mixed.length !== 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      mixed = a.webContents.mainFrame.framesInSubtree.filter(
        (frame) => frame.url === `http://localhost:${address.port}/671-cross`,
      )
    }
    assert.equal(mixed.length, 2, 'both identical-URL/name nested child documents loaded')
    assert(
      mixed.every((frame) => frame.parent && frame.processId !== frame.parent.processId),
      'actual cross-process nested frames required',
    )
    const recordChildFailure = async (expected: string) => {
      const read = async (frame: (typeof mixed)[number], expression: string) =>
        Promise.race([
          frame.executeJavaScript(expression).catch((error) => ({ error: String(error) })),
          new Promise((resolve) =>
            setTimeout(() => resolve({ error: 'diagnostic read timed out' }), 1000),
          ),
        ])
      writeFileSync(
        join(evidence, 'child-vim-failure.json'),
        JSON.stringify(
          {
            expected,
            focused: a.webContents.isFocused(),
            windowFocused: win.isFocused(),
            focusedFrame: a.webContents.focusedFrame && {
              processId: a.webContents.focusedFrame.processId,
              routingId: a.webContents.focusedFrame.routingId,
            },
            modes: sent
              .filter((event) => event.remote === 'A' && event.name === 'vim-mode')
              .slice(-12)
              .map((event) => ({
                payload: event.payload,
                currentFrame: reportFrames.get(event) === a.webContents.focusedFrame,
              })),
            root: await read(
              a.webContents.mainFrame,
              `({ hasFocus:document.hasFocus(), active:document.activeElement?.tagName, events:window.__holiSmokeNativeEvents })`,
            ),
            children: await Promise.all(
              a.webContents.mainFrame.framesInSubtree
                .filter((frame) => frame.url === `http://localhost:${address.port}/671-cross`)
                .map(async (frame) => ({
                  processId: frame.processId,
                  routingId: frame.routingId,
                  page: await read(
                    frame,
                    `({ hasFocus:document.hasFocus(), active:document.activeElement?.id, value:document.querySelector('#child-field')?.value, selection:document.querySelector('#child-field')?.selectionStart, events:window.nativeEvents })`,
                  ),
                })),
            ),
          },
          null,
          2,
        ),
      )
    }
    const freshMode = async (after: number, mode: 'insert' | 'normal') => {
      for (let attempt = 0; attempt < 250; attempt++) {
        const event = sent
          .slice(after)
          .findLast((entry) => entry.remote === 'A' && entry.name === 'vim-mode')
        if (
          (event?.payload as { mode?: string } | undefined)?.mode === mode &&
          event &&
          reportFrames.get(event) === a.webContents.focusedFrame
        )
          return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await recordChildFailure(mode)
      throw new Error(`timed out after 5000ms waiting for current child ${mode} mode`)
    }
    const focusChild = async (frame: (typeof mixed)[number]) => {
      const after = sent.length
      for (let attempt = 0; attempt < 200; attempt++) {
        if (
          await frame
            .executeJavaScript(`!!document.querySelector('#child-field')`)
            .catch(() => false)
        )
          break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      a.webContents.focus()
      await frame.executeJavaScript(
        `document.querySelector('#child-field').focus();document.querySelector('#child-field').setSelectionRange(4,4)`,
      )
      await waitFor(
        () => (a.webContents.focusedFrame === frame ? true : undefined),
        'native focus confirmation for the loaded child',
      ).catch(async (error) => {
        await recordChildFailure('native child focus')
        throw error
      })
      await freshMode(after, 'insert')
    }
    const holdNormalRead = async (work: (release: () => void) => Promise<void>) => {
      let enter!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const delayed = new Promise<void>((resolve) => {
        release = resolve
      })
      const originalCommand = a.webContents.debugger.sendCommand.bind(a.webContents.debugger)
      let holdNextEvaluation = true
      a.webContents.debugger.sendCommand = async (method, params, sessionId) => {
        const result = await originalCommand(method, params, sessionId)
        const observed = result?.result?.value
        if (
          holdNextEvaluation &&
          method === 'Runtime.evaluate' &&
          observed?.enabled === true &&
          observed.mode === 'normal'
        ) {
          holdNextEvaluation = false
          enter()
          await delayed
        }
        return result
      }
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          entered,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error('timed out after 5000ms waiting for native child evaluation')),
              5000,
            )
          }),
        ])
        clearTimeout(deadline)
        await work(release)
      } finally {
        clearTimeout(deadline)
        release()
        a.webContents.debugger.sendCommand = originalCommand
      }
    }
    assert(
      mixed.every(
        (frame) =>
          frame.parent?.url === `${url}/671-parent` &&
          frame.parent.parent === a.webContents.mainFrame,
      ),
      'nested native ancestry required',
    )
    assert.equal(mixed[0]!.name, mixed[1]!.name, 'duplicate frame names required')
    const nativeFrames = mixed.map((frame) => ({
      processId: frame.processId,
      routingId: frame.routingId,
      frameToken: frame.frameToken,
      url: frame.url,
      name: frame.name,
      parent: {
        processId: frame.parent!.processId,
        routingId: frame.parent!.routingId,
        url: frame.parent!.url,
      },
    }))
    await focusChild(mixed[0]!)
    let after = sent.length
    await childPress('Escape')
    await freshMode(after, 'normal')
    await childPress('h')
    assert.equal(
      await mixed[0]!.executeJavaScript(`document.querySelector('#child-field').selectionStart`),
      3,
    )
    await childPress('l')
    await childPress('i')
    await childPress('x')
    assert.equal(
      await mixed[0]!.executeJavaScript(`document.querySelector('#child-field').value`),
      'one xtwo',
    )
    assert.equal(
      await mixed[1]!.executeJavaScript(`document.querySelector('#child-field').value`),
      'one two',
    )
    await freshMode(after, 'insert')
    mark('native-child-vim-nested-oopif-and-duplicate-owner-isolation')
    after = sent.length
    await childPress('Escape')
    await freshMode(after, 'normal')
    await holdNormalRead(async (release) => {
      const resumed = sent.length
      await mixed[1]!.executeJavaScript(`document.querySelector('#child-field').focus()`)
      await mixed[0]!.executeJavaScript(
        `document.querySelector('#child-field').focus();document.querySelector('#child-field').setSelectionRange(4,4)`,
      )
      assert.equal(a.webContents.focusedFrame, mixed[0])
      release()
      await freshMode(resumed, 'insert')
      await childPress('h')
      assert.equal(
        await mixed[0]!.executeJavaScript(`document.querySelector('#child-field').value`),
        'one hxtwo',
      )
    })
    await mixed[0]!.executeJavaScript(`document.querySelector('#child-field').value='one xtwo'`)
    mark('native-child-vim-held-normal-result-rejected-after-focus-aba')
    await focusChild(mixed[1]!)
    await childPress('h')
    assert.equal(
      await mixed[1]!.executeJavaScript(`document.querySelector('#child-field').value`),
      'one htwo',
      'newly focused child starts insert',
    )
    after = sent.length
    await childPress('Escape')
    await freshMode(after, 'normal')
    await holdNormalRead(async (release) => {
      await applyVimConfig(vimSnapshot, false, 5)
      const off = sent.length
      release()
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert(
        !sent
          .slice(off)
          .some(
            (event) =>
              event.remote === 'A' &&
              event.name === 'vim-mode' &&
              (event.payload as { mode?: string }).mode === 'normal',
          ),
        'late native mode result cannot re-enable or publish normal after disable',
      )
      mark('native-child-vim-late-mode-result-cannot-outlive-disable')
    })
    await childPress('h')
    assert.equal(
      await mixed[1]!.executeJavaScript(`document.querySelector('#child-field').value`),
      'one hhtwo',
      'preference off restores native typing',
    )
    await applyVimConfig(vimSnapshot, true, 6)
    configureVim(vimSnapshot, false, 5)
    after = sent.length
    await childPress('Escape')
    await childPress('h')
    assert.equal(
      await mixed[1]!.executeJavaScript(`document.querySelector('#child-field').value`),
      'one hhtwo',
      'stale disable cannot restore native typing over current enable',
    )
    assert.equal(
      await mixed[1]!.executeJavaScript(`document.querySelector('#child-field').selectionStart`),
      5,
    )
    await freshMode(after, 'normal')
    mark('native-child-vim-stale-disable-rejected-after-enable')
    const peer = mixed[0]!
    const departed = mixed[1]!
    await departed.parent!.executeJavaScript(
      `{const old=document.querySelectorAll('iframe')[1];const fresh=document.createElement('iframe');fresh.name=old.name;fresh.src=old.src;old.replaceWith(fresh)}`,
    )
    let replacement: typeof departed | undefined
    for (let attempt = 0; attempt < 200; attempt++) {
      replacement = a.webContents.mainFrame.framesInSubtree.find(
        (frame) =>
          frame.url === `http://localhost:${address.port}/671-cross` &&
          frame !== peer &&
          frame !== departed,
      )
      if (replacement) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert(replacement && departed.detached, 'replacement has fresh native identity')
    await focusChild(replacement)
    await childPress('h')
    assert.equal(
      await replacement.executeJavaScript(`document.querySelector('#child-field').value`),
      'one htwo',
    )
    assert.equal(
      await peer.executeJavaScript(`document.querySelector('#child-field').value`),
      'one xtwo',
    )
    const observed = (await replacement.executeJavaScript('window.nativeEvents')) as Array<{
      type: string
      key?: string
      trusted: boolean
    }>
    assert(
      observed.some((event) => event.type === 'keydown' && event.key === 'h') &&
        observed.every((event) => event.trusted),
      'trusted native events required',
    )
    mark('native-child-vim-replacement-reset-and-preference-passthrough')
    writeFileSync(
      join(evidence, 'child-vim.json'),
      JSON.stringify(
        {
          ok: true,
          source: process.env.HOLI_553_SHA,
          sourceHash: process.env.HOLI_553_SOURCE_HASH,
          worktreeStatus: process.env.HOLI_553_STATUS,
          electron: process.versions.electron,
          nativeFrames,
          events: observed,
        },
        null,
        2,
      ),
    )
    const { nativeTheme } = await import('electron')
    for (const theme of ['light', 'dark'] as const) {
      nativeTheme.themeSource = theme
      await new Promise((resolve) => setTimeout(resolve, 80))
      const image = await a.webContents.capturePage()
      assert(!image.isEmpty())
      writeFileSync(join(evidence, `child-vim-${theme}.png`), image.toPNG())
    }
    nativeTheme.themeSource = 'system'
    await inPage(a, `document.querySelector('iframe').srcdoc = ${JSON.stringify(original)}`)
  }
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
  ] as const) {
    await inPage(a, `document.querySelector('${selector}').focus()`)
    await nativePress(a, key)
    const value = await inPage<string>(
      a,
      `document.querySelector('${selector}').${selector === '#inert' ? 'innerText' : 'value'}`,
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
  for (const selector of ['#rich-block', '#rich-atom', '#rich-nested', '#rich-inert']) {
    await inPage(a, `document.querySelector('${selector}').focus()`)
    const before = await inPage<string>(a, `document.querySelector('${selector}').innerHTML`)
    await nativePress(a, 'Escape')
    await nativePress(a, 'w')
    const after = await inPage<string>(a, `document.querySelector('${selector}').innerHTML`)
    assert.notEqual(after, before, `${selector} accepts native text instead of swallowing it`)
    const mode = await a.webContents.executeJavaScriptInIsolatedWorld(1017, [
      { code: '__holiPage.vim.mode().mode' },
    ])
    assert.equal(mode, 'insert', `${selector} cannot enter normal mode`)
  }
  mark('rich-block-atom-and-nested-hosts-remain-native')
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
  await nativePress(a, 'Right', 'Right', true)
  assert.equal(await inPage<boolean>(a, 'getSelection().isCollapsed'), false)
  await nativePress(a, 'i')
  assert.equal(await inPage<boolean>(a, 'getSelection().isCollapsed'), true)
  await nativePress(a, 'X')
  assert.equal(
    await inPage<string>(a, `document.querySelector('#plaintext').textContent`),
    `X${plainAfterInsert}`,
    'plaintext i inserts before a normal-mode selection instead of replacing it',
  )
  a.webContents.undo()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(
    await inPage<string>(a, `document.querySelector('#plaintext').textContent`),
    plainAfterInsert,
  )
  mark('native-plaintext-selection-i-keeps-insert-before-selection-behavior')

  const originalRichMarkup = await inPage<string>(a, `document.querySelector('#rich').innerHTML`)
  await applyVimConfig(vimSnapshot, false, 7)
  const setLinkStart = () =>
    inPage(
      a,
      `(() => { const host=document.querySelector('#rich'); const n=host.querySelector('a').firstChild; host.focus(); const r=document.createRange(); r.setStart(n,0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r) })()`,
    )
  const richSelection = () =>
    inPage(
      a,
      `(() => { const s=getSelection(); const n=s.anchorNode; return { node:n?.nodeName, parent:n?.parentElement?.tagName, offset:s.anchorOffset, text:n?.textContent, collapsed:s.isCollapsed } })()`,
    )
  // Establish Blink's actual affinity at an anchor's first text offset without
  // enabling Holi Vim. The enabled path must preserve this exact selection and
  // the same markup/undo behavior, rather than assume the insertion belongs in
  // the link based on a guessed Range affinity.
  await setLinkStart()
  const nativeBefore = await richSelection()
  await nativePress(a, 'X')
  const nativeBaselineMarkup = await inPage<string>(a, `document.querySelector('#rich').innerHTML`)
  const nativeBaselineSelection = await richSelection()
  a.webContents.undo()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(
    await inPage<string>(a, `document.querySelector('#rich').innerHTML`),
    originalRichMarkup,
  )
  a.webContents.redo()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(
    await inPage<string>(a, `document.querySelector('#rich').innerHTML`),
    nativeBaselineMarkup,
  )
  a.webContents.undo()
  await new Promise((resolve) => setTimeout(resolve, 40))
  await applyVimConfig(vimSnapshot, true, 8)
  await setLinkStart()
  assert.deepEqual(await richSelection(), nativeBefore)
  await nativePress(a, 'Escape')
  await nativePress(a, 'i')
  assert.deepEqual(await richSelection(), nativeBefore, 'Escape → i preserves the native Range')
  await nativePress(a, 'X')
  const affinityMarkup = await inPage<string>(a, `document.querySelector('#rich').innerHTML`)
  assert.equal(affinityMarkup, nativeBaselineMarkup, 'Vim insertion matches native baseline markup')
  assert.deepEqual(await richSelection(), nativeBaselineSelection)
  a.webContents.undo()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(
    await inPage<string>(a, `document.querySelector('#rich').innerHTML`),
    originalRichMarkup,
  )
  a.webContents.redo()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(await inPage<string>(a, `document.querySelector('#rich').innerHTML`), affinityMarkup)
  const vimAfterSelection = await richSelection()
  a.webContents.undo()
  await new Promise((resolve) => setTimeout(resolve, 40))
  mark('native-baseline-and-vim-rich-link-start-affinity-undo-redo')
  const richBaselineEvidence = {
    baselineMode: 'disabled',
    markup: nativeBaselineMarkup,
    beforeSelection: nativeBefore,
    afterSelection: nativeBaselineSelection,
    vimMarkup: affinityMarkup,
    vimAfterSelection,
  }
  writeFileSync(join(evidence, 'rich-affinity.json'), JSON.stringify(richBaselineEvidence, null, 2))
  await inPage(
    a,
    `(() => { const host = document.querySelector('#rich'); const node = host.querySelector('strong').firstChild; host.focus(); const range = document.createRange(); range.setStart(node, 0); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range) })()`,
  )
  await nativePress(a, 'Escape')
  await nativePress(a, 'w')
  assert.equal(
    await inPage<boolean>(
      a,
      `(() => { const host = document.querySelector('#rich'); const s = getSelection(); return host.contains(s.anchorNode) && s.anchorNode.parentElement.closest('a') === host.querySelector('a') })()`,
    ),
    true,
    'word motion crosses the bold-to-link formatting boundary without flattening markup',
  )
  assert.equal(
    await inPage<string>(a, `document.querySelector('#rich').innerHTML`),
    originalRichMarkup,
  )
  await inPage(
    a,
    `(() => { const host = document.querySelector('#rich'); const node = host.querySelector('a').firstChild; const range = document.createRange(); range.setStart(node, 5); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range) })()`,
  )
  await nativePress(a, 'l')
  assert.equal(
    await inPage<number>(a, `getSelection().anchorOffset`),
    7,
    'l crosses an emoji grapheme atomically',
  )
  await nativePress(a, 'i')
  await nativePress(a, 'x')
  const changedRichMarkup = await inPage<string>(a, `document.querySelector('#rich').innerHTML`)
  assert.notEqual(changedRichMarkup, originalRichMarkup)
  assert.match(changedRichMarkup, /<a href="\/next">café🙂x link<\/a>/)
  a.webContents.undo()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(
    await inPage<string>(a, `document.querySelector('#rich').innerHTML`),
    originalRichMarkup,
  )
  a.webContents.redo()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(
    await inPage<string>(a, `document.querySelector('#rich').innerHTML`),
    changedRichMarkup,
  )
  a.webContents.undo()
  await new Promise((resolve) => setTimeout(resolve, 40))
  await inPage(
    a,
    `(() => { const host = document.querySelector('#rich'); const node = host.querySelector('a').firstChild; host.focus(); const range = document.createRange(); range.setStart(node, 0); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range) })()`,
  )
  await nativePress(a, 'Escape')
  await inPage(
    a,
    `(() => { const host=document.querySelector('#rich'); host.style.display='inline'; host.style.display='block' })()`,
  )
  await nativePress(a, 'Q')
  const richAfterShapeTransition = await inPage<string>(
    a,
    `document.querySelector('#rich').innerHTML`,
  )
  assert.notEqual(richAfterShapeTransition, originalRichMarkup)
  assert.equal(
    await a.webContents.executeJavaScriptInIsolatedWorld(1017, [
      { code: '__holiPage.vim.mode().mode' },
    ]),
    'insert',
    'CSS eligibility transition retires rich normal-mode ownership',
  )
  mark('rich-css-loss-and-restoration-retains-native-key-ownership')
  await inPage(a, `document.querySelector('#rich').innerHTML=${JSON.stringify(originalRichMarkup)}`)
  await setLinkStart()
  await nativePress(a, 'Escape')
  await inPage(
    a,
    `(() => { const link = document.querySelector('#rich a'); link.removeAttribute('href'); link.setAttribute('href', '/next') })()`,
  )
  assert.equal(
    await a.webContents.executeJavaScriptInIsolatedWorld(1017, [
      { code: '__holiPage.vim.mode().mode' },
    ]),
    'insert',
  )
  await nativePress(a, 'x')
  assert.notEqual(
    await inPage<string>(a, `document.querySelector('#rich').innerHTML`),
    originalRichMarkup,
    'link eligibility loss and restoration releases normal-mode key ownership',
  )
  mark('rich-href-loss-and-restoration-retains-native-key-ownership')
  await inPage(a, `document.querySelector('#rich').innerHTML=${JSON.stringify(originalRichMarkup)}`)
  await setLinkStart()
  await nativePress(a, 'Escape')
  await inPage(
    a,
    `(() => { const child = document.querySelector('#rich strong'); child.setAttribute('inert', ''); child.removeAttribute('inert') })()`,
  )
  assert.equal(
    await a.webContents.executeJavaScriptInIsolatedWorld(1017, [
      { code: '__holiPage.vim.mode().mode' },
    ]),
    'insert',
  )
  await nativePress(a, 'x')
  assert.notEqual(
    await inPage<string>(a, `document.querySelector('#rich').innerHTML`),
    originalRichMarkup,
    'inert transition releases normal-mode key ownership even when restored',
  )
  mark('rich-inert-transition-releases-native-key-ownership')
  await inPage(a, `document.querySelector('#rich').innerHTML=${JSON.stringify(originalRichMarkup)}`)
  await setLinkStart()
  if (!a.webContents.debugger.isAttached()) a.webContents.debugger.attach('1.3')
  await a.webContents.debugger.sendCommand('Input.imeSetComposition', {
    text: '日本語',
    selectionStart: 3,
    selectionEnd: 3,
  })
  await a.webContents.debugger.sendCommand('Input.insertText', { text: '日本語' })
  const composedRichMarkup = await inPage<string>(a, `document.querySelector('#rich').innerHTML`)
  assert.match(composedRichMarkup, /<strong>bold<\/strong>/)
  assert(composedRichMarkup.includes('日本語'))
  assert.match(composedRichMarkup, /<a href="\/next">café🙂 link<\/a>/)
  mark('native-rich-inline-ime-composition-retains-formatting-and-link')
  mark('native-rich-inline-motion-insert-undo-redo-preserves-formatting-and-link')

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

  await applyVimConfig(vimSnapshot, false, 9)
  await setPlainSelection('#plaintext')
  const disabledPlain = await inPage<string>(a, `document.querySelector('#plaintext').textContent`)
  await nativePress(a, 'q')
  assert.notEqual(
    await inPage<string>(a, `document.querySelector('#plaintext').textContent`),
    disabledPlain,
  )
  await applyVimConfig(vimSnapshot, true, 10)
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
  const ownsCompositionDebugger = !a.webContents.debugger.isAttached()
  if (ownsCompositionDebugger) a.webContents.debugger.attach('1.3')
  try {
    await a.webContents.debugger.sendCommand('Input.imeSetComposition', {
      text: '日本語',
      selectionStart: 3,
      selectionEnd: 3,
    })
    await a.webContents.debugger.sendCommand('Input.insertText', { text: '日本語' })
  } finally {
    if (ownsCompositionDebugger) a.webContents.debugger.detach()
  }
  assert((await inPage<string>(a, `document.querySelector('#text').value`)).includes('日本語'))
  mark('native-ime-composition-in-insert-mode')
  await inPage(a, `document.querySelector('#text').value = 'one two three'`)
  await applyVimConfig(vimSnapshot, false, 11)
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
  await applyVimConfig(vimSnapshot, true, 12)
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
  checks.push(...(await runAppFrameSmoke(root, evidence)))
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
          'vault-app-a.png',
          'vault-app-b.png',
          'app-frame-read-a.png',
          'app-frame-read-b.png',
          'app-frame-b-after-a-teardown.png',
          'app-hints-light.png',
          'app-hints-dark.png',
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
