import { app, BrowserWindow, ipcMain, nativeTheme, shell, type WebFrameMain } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc, listenForPluginMessages, createRendererFlushChannel } from '../src/main/ipc'
import { isApplicationSender, type SenderEvent } from '../src/main/application-sender'
import { pluginEvents } from '../src/main/plugin-host/events'
import { requestFlush } from '../src/main/flush'
import { captureTab } from '../src/main/tab-capture'

const root = process.env.HOLI_506_ROOT!
const evidence = process.env.HOLI_506_EVIDENCE!
let entry = process.env.HOLI_506_ENTRY!
const crossEntry = process.env.HOLI_506_CROSS_ENTRY!
const checks: string[] = []
let current: BrowserWindow | null = null
let lastEvent: SenderEvent | undefined
let exitCode = 0

function authorize(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  lastEvent = event
  return isApplicationSender(
    event,
    current && !current.isDestroyed() ? current.webContents : null,
    entry,
  )
}

function check(condition: unknown, name: string): asserts condition {
  if (!condition) throw new Error(`native assertion failed: ${name}`)
  checks.push(name)
}

async function evaluate(frame: BrowserWindow | WebFrameMain, code: string): Promise<unknown> {
  return ('webContents' in frame ? frame.webContents : frame).executeJavaScript(code)
}

async function send(frame: BrowserWindow | WebFrameMain, channel: string, ...args: unknown[]) {
  await evaluate(
    frame,
    `window.fixture.send(${JSON.stringify(channel)},...${JSON.stringify(args)}); window.fixture.invoke('fixture:barrier')`,
  )
}

async function query(frame: BrowserWindow | WebFrameMain): Promise<boolean> {
  const result = (await evaluate(
    frame,
    `window.fixture.invoke('holi:trpc',{path:'smoke.query',type:'query',input:{ok:true}})`,
  )) as { ok: boolean }
  return result.ok
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await read()
    if (ready(result)) return result
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('native fixture did not become ready')
}

void (async () => {
  let stopPlugin: (() => void) | undefined
  let stopFlush: (() => void) | undefined
  try {
    app.setPath('userData', join(root, 'user-data'))
    app.setPath('sessionData', join(root, 'session-data'))
    await mkdir(join(root, 'packaged'), { recursive: true })
    await mkdir(evidence, { recursive: true })
    await app.whenReady()
    ipcMain.handle('fixture:barrier', () => undefined)
    let calls = 0
    let nativeCalls = 0
    const router = {
      createCaller: () => ({
        smoke: {
          query: async () => {
            calls++
            return { ok: true }
          },
        },
      }),
    } as never
    registerIpc({ router, rootFor: async () => null, authorizeSender: authorize })
    shell.showItemInFolder = () => {
      nativeCalls++
    }

    const preload = join(root, 'fixture-preload.cjs')
    await writeFile(
      preload,
      `const {contextBridge,ipcRenderer}=require('electron');
      const requests={};
      for(const name of ['flush','locate']) ipcRenderer.on('vault:'+name,(_event,value)=>{requests[name]=value});
      contextBridge.exposeInMainWorld('fixture',{
        invoke:(c,...a)=>ipcRenderer.invoke(c,...a),
        send:(c,...a)=>ipcRenderer.send(c,...a),
        peek:name=>requests[name]
      });`,
    )
    // Fixture-only subframe preload deliberately supplies IPC to hostile frames.
    // Production does not enable this; this proves the main-process defense too.
    const preferences = {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      backgroundThrottling: false,
      preload,
    }
    const makeWindow = () =>
      new BrowserWindow({
        show: false,
        width: 640,
        height: 480,
        webPreferences: preferences,
      })
    const good = makeWindow()
    current = good
    await good.loadURL(entry)
    check(await query(good), 'current top-level tRPC request succeeds')
    check(calls === 1, 'authorized router procedure invoked exactly once')
    await evaluate(good, `window.fixture.invoke('holi:openPath',${JSON.stringify(root)})`)
    check(nativeCalls === 1, 'authorized production native invoke takes effect')

    const foreign = makeWindow()
    await foreign.loadURL(entry)
    check(!(await query(foreign)) && calls === 1, 'same-URL foreign window rejected before router')
    const invokeRejected = await evaluate(
      foreign,
      `window.fixture.invoke('holi:openPath',${JSON.stringify(root)}).then(()=>false,error=>error.message.includes('current Holi'))`,
    )
    check(invokeRejected && nativeCalls === 1, 'foreign native invoke rejects before side effects')
    nativeTheme.themeSource = 'light'
    await send(foreign, 'holi:appearance', 'dark')
    check(nativeTheme.themeSource === 'light', 'foreign native one-way event has no effect')
    await send(good, 'holi:appearance', 'dark')
    check(nativeTheme.themeSource === 'dark', 'authorized native one-way event takes effect')

    let pluginCalls = 0
    const events = pluginEvents(
      {
        send: () => {},
        listen: (channel, handler) => listenForPluginMessages(channel, handler, authorize),
        liveRemote: () => 'fixture/vault',
      },
      'fixture',
    )
    stopPlugin = events.on('ping', () => {
      pluginCalls++
    })
    const message = { remote: 'fixture/vault', name: 'ping', payload: null }
    await send(foreign, 'plugin:fixture', message)
    await events.drain()
    check(pluginCalls === 0, 'foreign plugin message cannot enter the production plugin adapter')
    await send(good, 'plugin:fixture', message)
    await events.drain()
    check(pluginCalls === 1, 'authorized plugin message reaches its production consumer')

    await evaluate(
      good,
      `for (const src of ${JSON.stringify([entry + 'child', crossEntry])}) {
      const frame=document.createElement('iframe');frame.src=src;document.body.append(frame)
    }`,
    )
    await waitFor(
      async () => good.webContents.mainFrame.frames,
      (frames) =>
        frames.length === 2 &&
        frames.every((frame) => frame.url && frame.url !== 'about:blank' && !frame.detached),
    )
    for (const frame of good.webContents.mainFrame.frames) {
      await waitFor(() => frame.executeJavaScript('Boolean(window.fixture)'), Boolean)
      check(
        !(await query(frame)) && calls === 1,
        `subframe router denied (${new URL(frame.url).origin})`,
      )
      await send(frame, 'plugin:fixture', message)
      await events.drain()
      check(pluginCalls === 1, 'subframe plugin event denied')
      await send(frame, 'holi:appearance', 'light')
      check(nativeTheme.themeSource === 'dark', 'subframe native event denied')
    }

    let flushed = false
    const flush = requestFlush(createRendererFlushChannel(good, authorize), 5_000)
    void flush.then(() => {
      flushed = true
    })
    const flushRequest = await waitFor(
      () => evaluate(good, `window.fixture.peek('flush')`) as Promise<{ id: string } | undefined>,
      (value) => Boolean(value?.id),
    )
    await send(foreign, 'vault:flush-done', flushRequest!.id)
    await send(good.webContents.mainFrame.frames[0]!, 'vault:flush-done', flushRequest!.id)
    await send(good, 'vault:flush-done', 'wrong-request')
    check(!flushed, 'foreign/subframe acknowledgements and wrong request IDs cannot settle flush')
    await send(good, 'vault:flush-done', flushRequest!.id)
    check(
      (await flush) === 'flushed',
      'authorized flush acknowledgement settles production request',
    )
    check(
      ipcMain.listenerCount('vault:flush-done') === 0,
      'flush listener is removed after settlement',
    )

    let located = false
    const capture = captureTab(good, 'fixture.md', Promise.resolve(), authorize)
    void capture.then(
      () => {
        located = true
      },
      () => {},
    )
    const locateRequest = await waitFor(
      () => evaluate(good, `window.fixture.peek('locate')`) as Promise<{ id: string } | undefined>,
      (value) => Boolean(value?.id),
    )
    const answer = { id: locateRequest!.id, rect: { x: 0, y: 0, width: 100, height: 100 } }
    await send(foreign, 'vault:located', answer)
    await send(good.webContents.mainFrame.frames[0]!, 'vault:located', answer)
    check(!located, 'foreign/subframe location replies cannot settle capture')
    await send(good, 'vault:located', answer)
    const image = await capture
    check(image.length > 8, 'authorized location reply produces a real production PNG capture')
    check(
      ipcMain.listenerCount('vault:located') === 0,
      'capture listener is removed after settlement',
    )

    await query(good)
    const staleEvent = lastEvent!
    await good.loadURL(entry + 'other')
    check(
      !(await query(good)),
      'owned window on another same-origin document is denied by actual IPC',
    )
    check(
      !isApplicationSender(staleEvent, good.webContents, entry),
      'real old-document sender event fails closed after navigation',
    )
    await good.loadURL(crossEntry)
    check(!(await query(good)), 'owned window on another port is denied by actual IPC')
    await good.loadURL(entry + '?reload=1#tab')
    check(await query(good), 'configured document query/fragment reload remains authorized')

    const file = join(root, 'packaged/index.html')
    const other = join(root, 'packaged/other.html')
    await writeFile(file, '<!doctype html><body>Packaged document fixture</body>')
    await writeFile(other, '<!doctype html><body>Foreign packaged document</body>')
    entry = pathToFileURL(file).href
    await good.loadURL(entry)
    check(await query(good), 'exact packaged file document is authorized through native IPC')
    await foreign.loadURL(entry)
    check(!(await query(foreign)), 'same packaged file in foreign webContents is denied')
    await good.loadURL(pathToFileURL(other).href)
    check(!(await query(good)), 'owned window on another packaged file is denied')
    await good.loadURL(entry + '?reload=2#tab')
    check(await query(good), 'packaged query/fragment reload remains authorized')

    let staleAcknowledged = false
    stopFlush = createRendererFlushChannel(good, authorize).onDone(() => {
      staleAcknowledged = true
    })
    await query(good)
    const closedEvent = lastEvent!
    const replacement = makeWindow()
    current = replacement
    await replacement.loadURL(entry)
    check(!(await query(good)), 'replaced but living application window loses authorization')
    good.destroy()
    check(
      !isApplicationSender(closedEvent, replacement.webContents, entry),
      'destroyed-window native event fails closed',
    )
    await send(replacement, 'vault:flush-done', 'old-request')
    check(
      !staleAcknowledged,
      'new window cannot settle a destroyed target request or throw from its getters',
    )
    stopFlush()
    stopFlush = undefined
    check(await query(replacement), 'new current application window is authorized')
    stopPlugin()
    stopPlugin = undefined
    await send(replacement, 'plugin:fixture', message)
    check(pluginCalls === 1, 'disposed plugin adapter no longer delivers messages')

    await writeFile(
      join(evidence, 'result.json'),
      JSON.stringify(
        {
          ok: true,
          electron: process.versions.electron,
          checks,
          scenarios: checks.length,
          roots: { profile: join(root, 'user-data'), session: join(root, 'session-data') },
        },
        null,
        2,
      ),
    )
  } catch (error) {
    await writeFile(
      join(evidence, 'result.json'),
      JSON.stringify({ ok: false, checks, error: String(error) }, null, 2),
    )
    console.error(error)
    exitCode = 1
  } finally {
    stopPlugin?.()
    stopFlush?.()
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy()
    app.exit(exitCode)
  }
})()
