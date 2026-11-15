import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { emptyVaultSnapshot, VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { createPluginHost, type OpenVault } from '../src/main/plugin-host/host'
import type { MainPlugin, Notice, PluginCtx } from '../src/main/plugin-api'
import { createInbox, type Inbox } from '../src/plugins/agent/main/inbox/inbox'
import { parseInbox } from '../src/plugins/agent/main/inbox/rules'
import { agentCapabilities } from '../src/plugins/agent/main/host/capabilities'

const root = process.env.HOLI_542_ROOT!
const evidence = process.env.HOLI_542_EVIDENCE!
const remoteA = 'smoke/542-vault'
const remoteB = 'smoke/other-vault'
const checks: string[] = []
const denied: string[] = []
const captures: string[] = []
const lifecycle: string[] = []
const operations: { path: string; input: unknown }[] = []
const backendSpawns: string[] = []
const frames: { file: string; timestamp: number }[] = []
const mark = (name: string) => checks.push(name)
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// This clock is the smoke driver's timeout, never a render-time UI value.
const waitFor = async (win: BrowserWindow, expression: string) => {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expression)) return
    await pause(80)
  }
  const state = await win.webContents.executeJavaScript('window.smoke542.state()')
  throw new Error(`Timed out waiting for ${expression}\n${JSON.stringify(state)}`)
}

async function run() {
  const isolatedRoots = {
    userData: join(root, 'user-data'),
    appData: join(root, 'app-data'),
    sessionData: join(root, 'session-data'),
    vault: join(root, 'vaults'),
  }
  for (const path of [...Object.values(isolatedRoots), evidence, join(evidence, 'frames')])
    mkdirSync(path, { recursive: true })
  app.setName('Holi issue 542 smoke')
  app.setPath('appData', isolatedRoots.appData)
  app.setPath('userData', isolatedRoots.userData)
  app.setPath('sessionData', isolatedRoots.sessionData)
  process.env.HOLI_VAULT_ROOT = isolatedRoots.vault
  assert.equal(app.getPath('userData'), isolatedRoots.userData)
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^(file|data|devtools):/.test(details.url)) callback({})
    else {
      denied.push(details.url)
      callback({ cancel: true })
    }
  })
  const providers = [
    { id: 'a1b2c3d4', provider: 'claude', name: 'Claude review' },
    { id: 'p0123456789ac', provider: 'codex', name: 'Codex review' },
    { id: 'p0123456789ab', provider: 'pi', name: 'Pi review' },
  ]
  const sessionsFor = (remote: string) =>
    (remote === remoteA
      ? providers
      : [{ id: 'b1b2c3d4', provider: 'claude', name: 'Other vault session' }]
    ).map((row) => ({ ...row, state: 'idle' as const }))
  const terminalsFor = (remote: string) =>
    sessionsFor(remote).map((row) => ({
      id: `terminal-${row.provider}-${remote === remoteA ? 'a' : 'b'}`,
      launchedFor: row.id,
      title: row.name,
    }))
  const vaults = [remoteA, remoteB].map((remote) => ({
    remote,
    name: remote,
    path: join(isolatedRoots.vault, remote),
  }))
  vaults.forEach((vault) => mkdirSync(vault.path, { recursive: true }))
  const snapshotFor = (remote: string) => ({ ...emptyVaultSnapshot(), dirs: [remote] })
  let active: OpenVault | null = null
  let win: BrowserWindow
  let clock = 1_800_000_000_000
  const contexts = new Map<string, PluginCtx>()
  const inboxes = new Map<string, Inbox>()
  const files = new Map(
    vaults.map(({ remote }) => [remote, parseInbox({ entries: [], seen: null })]),
  )
  const callbacks = new Map<string, () => void>()
  const send = (channel: string, payload: unknown) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
  const fixture: MainPlugin = {
    info: { id: 'agent', label: 'Agent fixture', builtIn: true, default: true },
    activate(ctx) {
      contexts.set(ctx.remote, ctx)
      lifecycle.push(`start:${ctx.remote}`)
      inboxes.set(
        ctx.remote,
        createInbox({
          store: {
            read: async () => files.get(ctx.remote)!,
            update: async (edit) => {
              const file = await edit(files.get(ctx.remote)!)
              files.set(ctx.remote, file)
              return file
            },
          },
          now: () => new Date((clock += 31_000)),
          notify: ctx.notify,
          changed: (payload) => ctx.emit(ctx.remote, 'inbox', payload),
        }),
      )
      return () => {
        lifecycle.push(`stop:${ctx.remote}`)
        contexts.delete(ctx.remote)
        inboxes.delete(ctx.remote)
      }
    },
  }
  const host = createPluginHost({
    plugins: [fixture],
    registry: { register: () => () => {} },
    userData: isolatedRoots.userData,
    coreSeeds: [],
    active: () => active,
    rootFor: async (remote) => vaults.find((vault) => vault.remote === remote)?.path ?? null,
    readSettings: async () => ({ ...VAULT_SETTING_DEFAULTS, warnings: [] }),
    events: {
      send: (_channel, event) => send('smoke-event', event),
      listen: () => () => {},
      liveRemote: () => active?.remote ?? null,
    },
    openAppDoor: () => {
      throw new Error('No app door in smoke')
    },
    route: () => () => {},
    binDir: () => root,
    githubToken: () => null,
    frameOrigin: () => () => {},
    focused: () => false,
    notify: (notice: Notice) => {
      assert.equal(typeof notice.onClick, 'function', 'production host must admit click callback')
      assert.equal(notice.navigate, undefined, 'host must capture navigation into onClick')
      callbacks.set(notice.title, notice.onClick!)
      return true
    },
    navigate: (plugin, remote, name, payload) =>
      send('vault:navigate', { plugin, remote, name, payload }),
  })
  const failSpawn = (name: string): never => {
    backendSpawns.push(name)
    throw new Error(`Unexpected backend spawn: ${name}`)
  }
  // The production agent.open policy, with controlled existing processes only.
  // All process-creating adapters fail closed; no provider binary is launched.
  const open = agentCapabilities({
    liveRemote: () => active?.remote ?? null,
    sessions: {
      open: async (args: { attach?: string }) => {
        if (args.attach === 'deadbeef') return { ok: false, message: 'That session has ended.' }
        if (args.attach === 'deadc0de') throw new Error('Session lookup rejected')
        const terminal = terminalsFor(active!.remote).find((row) => row.launchedFor === args.attach)
        return terminal ? { ok: true, terminalId: terminal.id } : failSpawn('claude.open')
      },
    } as never,
    own: {
      has: (id: string) =>
        terminalsFor(active!.remote).some((row) => row.launchedFor === id && id.startsWith('p')),
      terminalOf: (id: string) =>
        terminalsFor(active!.remote).find((row) => row.launchedFor === id)?.id ?? null,
      hasPast: async () => false,
      start: () => failSpawn('own.start'),
      reopen: () => failSpawn('own.reopen'),
    } as never,
    jobs: {
      has: (id: string) => id === 'j0123456789ab',
      start: () => failSpawn('jobs.start'),
    } as never,
    pi: {
      sessions: () => [{ id: 'facefeed', provider: 'pi', name: 'Pi background', state: 'idle' }],
    } as never,
    providers: () => [],
    defaultProvider: async () => 'claude',
    terminals: {} as never,
    fenced: {} as never,
    commitNow: async () => {},
  })['agent.open']
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    webPreferences: {
      preload: join(root, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  ipcMain.handle('542-smoke', async (event, action: string, payload?: unknown) => {
    assert.equal(event.sender, win.webContents)
    assert.equal(event.senderFrame, win.webContents.mainFrame)
    if (action === 'vaults') return vaults
    if (action !== 'trpc') throw new Error(`Unknown action ${action}`)
    const op = payload as {
      path: string
      input: { remote: string; name?: string; paramsJson?: string }
    }
    operations.push(op)
    const { remote, name, paramsJson } = op.input ?? {}
    const params = JSON.parse(paramsJson ?? '{}') as Record<string, unknown>
    if (op.path === 'vaults.open') {
      const vault = vaults.find((vault) => vault.remote === remote)
      assert(vault, 'only owned fixture vaults may open')
      if (active && active.remote !== remote) await host.stop(active.remote)
      active = {
        remote,
        root: vault.path,
        pause() {},
        resume() {},
        commitNow: async () => null,
        repo: { head: async () => 'fixture' },
      }
      host.setDisplayed(remote)
      await host.reconcile(active, 'open')
      assert.deepEqual(host.failures(remote), {})
      return snapshotFor(remote)
    }
    if (op.path === 'cap.names') return []
    assert.equal(op.path, 'cap.run')
    // Unmounting a departed vault can detach after main has opened the next.
    // Production treats that as a harmless miss, not a renderer rejection.
    if (name === 'agent.detach') return { ok: true }
    if (name === 'agent.open') return open.run({ remote } as never, open.params(params))
    assert.equal(remote, active?.remote, `read capability ${name} must target opened backend vault`)
    if (name === 'agent.sessions') return sessionsFor(remote)
    if (name === 'agent.terminals') return terminalsFor(remote)
    if (name === 'agent.inbox') return inboxes.get(remote)!.view()
    if (name === 'agent.inboxSeen') return inboxes.get(remote)!.seen()
    if (name === 'agent.inboxDismiss') return inboxes.get(remote)!.dismiss(String(params?.id))
    if (name === 'agent.attach') return 'Controlled existing PTY; no provider inference\r\n'
    if (name === 'agent.providers') return []
    if (name === 'agent.history' || name === 'agent.turns') return []
    throw new Error(`Unexpected capability ${name}`)
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  const errors: string[] = []
  win.webContents.on('console-message', (event) => {
    console.log(`RENDERER ${event.level}: ${event.message}`)
    if (event.level === 'error') errors.push(event.message)
  })
  win.webContents.on('render-process-gone', (_event, detail) =>
    errors.push(`renderer gone: ${detail.reason}`),
  )
  const js = (expression: string) => win.webContents.executeJavaScript(expression)
  const state = () => js('window.smoke542.state()')
  const capture = async (name: string) => {
    await pause(250)
    writeFileSync(join(evidence, name), (await win.capturePage()).toPNG())
    captures.push(name)
  }
  const clickRow = async (title: string) => {
    await waitFor(
      win,
      `Array.from(document.querySelectorAll('button')).some(n => n.innerText.includes(${JSON.stringify(title)}))`,
    )
    const point = await js(`(() => {
      const node = Array.from(document.querySelectorAll('button')).find(n => n.innerText.includes(${JSON.stringify(title)}));
      node.scrollIntoView({block:'center'}); const r = node.getBoundingClientRect();
      return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)};
    })()`)
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      clickCount: 1,
    })
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      clickCount: 1,
    })
  }
  const focused = (id: string) => `(() => {
    const target = document.querySelector('[data-session="${id}"]:not([hidden])');
    const input = document.activeElement;
    return !!target && input?.classList.contains('xterm-helper-textarea') && target.contains(input) && input.getBoundingClientRect().width > 0 && target.getBoundingClientRect().height > 0;
  })()`
  const assertSession = async (id: string, terminalId: string) => {
    await waitFor(win, focused(id))
    const current = await state()
    assert.deepEqual(current.active, { kind: 'session', id })
    assert.equal(current.activeSurface, `session:${id}`)
    assert.equal(current.viewTerminals[id], terminalId)
    assert.equal(
      current.tabs.filter(
        (tab: { kind: string; id: string }) => tab.kind === 'session' && tab.id === `session:${id}`,
      ).length,
      1,
    )
    assert.equal(
      current.tabs.some((tab: { kind: string }) => tab.kind === 'surface'),
      false,
    )
  }
  await win.loadFile(join(root, 'renderer.html'))
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Page.enable')
  win.webContents.debugger.on('message', (_event, method, params) => {
    if (method !== 'Page.screencastFrame') return
    const file = `frames/${String(frames.length).padStart(6, '0')}.jpg`
    writeFileSync(join(evidence, file), Buffer.from(params.data, 'base64'))
    frames.push({ file, timestamp: params.metadata.timestamp })
    void win.webContents.debugger.sendCommand('Page.screencastFrameAck', {
      sessionId: params.sessionId,
    })
  })
  await win.webContents.debugger.sendCommand('Page.startScreencast', {
    format: 'jpeg',
    quality: 85,
    everyNthFrame: 1,
  })
  await waitFor(
    win,
    `window.smoke542.state().sessions.length === 3 && window.smoke542.state().openedRemote === '${remoteA}'`,
  )
  assert.deepEqual((await state()).snapshot.dirs, [remoteA])
  mark('truthful-initial-vault-open-and-production-plugin-vault-lifecycle')
  for (const row of providers) {
    assert.equal(
      await inboxes.get(remoteA)!.raise({
        title: row.name,
        line: 'Review from the controlled existing session',
        session: row.id,
      }),
      'banner',
    )
    assert(callbacks.has(row.name))
  }
  await capture('inbox-light.png')
  await js(`document.documentElement.setAttribute('data-theme','dark')`)
  await capture('inbox-dark.png')
  await js(`document.documentElement.setAttribute('data-theme','light')`)
  const opens = () =>
    operations.filter((op) => (op.input as { name?: string })?.name === 'agent.open')
  const rowOpenBaseline = opens().length
  for (const row of providers) {
    const terminalId = terminalsFor(remoteA).find((terminal) => terminal.launchedFor === row.id)!.id
    await clickRow(row.name)
    await assertSession(row.id, terminalId)
    mark(`${row.provider}:production-inbox-row-canonical-session-tab-and-visible-xterm-focus`)
    // Cursor-position query is decoded by the real xterm after the marker.
    // Its PTY reply proves bytes traversed the production pty-data handler.
    const sentBefore = (await state()).sent.length
    contexts.get(remoteA)!.emit(remoteA, 'pty-data', {
      id: terminalId,
      data: `\x1b[2J\x1b[H${row.provider.toUpperCase()} 542 PTY proof\r\n\x1b[6n`,
    })
    await waitFor(
      win,
      `window.smoke542.state().sent.slice(${sentBefore}).some(e => e.event.remote === '${remoteA}' && e.event.name === 'pty-write' && e.event.payload.id === '${terminalId}' && e.event.payload.data === '\\x1b[2;1R')`,
    )
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'char',
      text: 'x',
    })
    await waitFor(
      win,
      `window.smoke542.state().sent.slice(${sentBefore}).some(e => e.event.payload?.id === '${terminalId}' && e.event.payload.data === 'x')`,
    )
    await capture(`${row.provider}-session-focused.png`)
    mark(
      `${row.provider}:pty-output-decoded-cursor-reply-and-native-keyboard-routed-to-correct-terminal`,
    )
    const terminalsBefore = (await state()).terminals
    await js(`window.smoke542.closeSession('${row.id}')`)
    await waitFor(win, `!document.querySelector('[data-session="${row.id}"]')`)
    await clickRow(row.name)
    await assertSession(row.id, terminalId)
    assert.deepEqual((await state()).terminals, terminalsBefore)
    assert.equal(opens().length, rowOpenBaseline)
    mark(`${row.provider}:closed-canonical-tab-reopened-unchanged-terminal-zero-agent-open`)
  }
  assert.equal(opens().length, 0)
  assert.deepEqual(backendSpawns, [])
  mark('all-provider-row-and-closed-tab-matrix-zero-agent-open-and-zero-backend-spawns')

  for (const row of providers) {
    const terminalId = terminalsFor(remoteA).find((terminal) => terminal.launchedFor === row.id)!.id
    const beforeNavigation = (await state()).navigationCount
    const beforeOpens = opens().length
    const beforeVaultOpens = operations.filter((op) => op.path === 'vaults.open').length
    callbacks.get(row.name)!()
    await waitFor(win, `window.smoke542.state().navigationCount === ${beforeNavigation + 1}`)
    await assertSession(row.id, terminalId)
    assert.equal(opens().length, beforeOpens)
    assert.equal(operations.filter((op) => op.path === 'vaults.open').length, beforeVaultOpens)
    assert.equal((await state()).openedRemote, remoteA)
    mark(`${row.provider}:same-vault-admitted-host-notice-callback-retains-terminal-and-focus`)
  }

  await js(`window.smoke542.switchVault('${remoteB}')`)
  await waitFor(
    win,
    `window.smoke542.state().sessions.length === 1 && window.smoke542.state().sessions[0].id === 'b1b2c3d4'`,
  )
  const beforeCross = await state()
  assert.equal(beforeCross.remote, remoteB)
  assert.equal(beforeCross.openedRemote, remoteB)
  assert.deepEqual(beforeCross.viewTerminals, {})
  assert.deepEqual(beforeCross.inbox.entries, [])
  assert.deepEqual(beforeCross.snapshot.dirs, [remoteB])
  assert.deepEqual(
    beforeCross.terminals.map((row: { id: string }) => row.id),
    ['terminal-claude-b'],
  )
  assert(lifecycle.includes(`stop:${remoteA}`))
  assert.equal(contexts.has(remoteA), false)
  await capture('other-vault-before-banner.png')
  const crossOpStart = operations.length
  // This is the callback admitted by production host.notify during A's OLD
  // activation, not a replacement callback manufactured while B is selected.
  callbacks.get('Pi review')!()
  await waitFor(
    win,
    `window.smoke542.state().navigationCount === ${providers.length + 1} && window.smoke542.state().sessions.length === 3`,
  )
  await assertSession('p0123456789ab', 'terminal-pi-a')
  const afterCross = await state()
  assert.equal(afterCross.remote, remoteA)
  assert.equal(afterCross.openedRemote, remoteA)
  assert.deepEqual(afterCross.snapshot.dirs, [remoteA])
  assert.equal(
    afterCross.sessions.some((row: { id: string }) => row.id === 'b1b2c3d4'),
    false,
  )
  assert.equal(
    afterCross.terminals.some((row: { id: string }) => row.id === 'terminal-claude-b'),
    false,
  )
  const crossOps = operations.slice(crossOpStart)
  assert(
    crossOps.some(
      (op) => op.path === 'vaults.open' && (op.input as { remote: string }).remote === remoteA,
    ),
  )
  assert(crossOps.some((op) => (op.input as { name?: string }).name === 'agent.sessions'))
  assert(crossOps.some((op) => (op.input as { name?: string }).name === 'agent.terminals'))
  const crossSentBefore = (await state()).sent.length
  contexts.get(remoteA)!.emit(remoteA, 'pty-data', {
    id: 'terminal-pi-a',
    data: '\x1b[2J\x1b[HPI origin vault restored by admitted notification callback\r\n\x1b[6n',
  })
  await waitFor(
    win,
    `window.smoke542.state().sent.slice(${crossSentBefore}).some(e => e.event.remote === '${remoteA}' && e.event.payload?.id === 'terminal-pi-a' && e.event.payload.data === '\\x1b[2;1R')`,
  )
  await capture('cross-vault-banner-session-focused.png')
  mark(
    'cross-vault-old-admitted-host-callback-survives-stop-switches-b-to-a-reloads-a-state-and-focuses-origin-terminal',
  )

  const refused = [
    { id: 'deadbeef', title: 'Ended session', message: 'That session has ended.' },
    { id: 'deadc0de', title: 'Unavailable session', message: 'Session lookup rejected' },
    { id: 'j0123456789ab', title: 'Codex job', message: 'A job runs with no terminal' },
    { id: 'facefeed', title: 'Pi background run', message: 'Pi background sessions have no TUI' },
  ]
  for (const row of refused) {
    await inboxes
      .get(remoteA)!
      .raise({ title: row.title, line: 'Controlled refusal; no new session', session: row.id })
    const before = await state()
    const callsBefore = opens().length
    await clickRow(row.title)
    await waitFor(
      win,
      `Array.from(document.querySelectorAll('[data-sonner-toast]')).some(n => n.innerText.includes('Could not open agent session') && n.innerText.includes(${JSON.stringify(row.message)}))`,
    )
    const after = await state()
    assert.equal(opens().length, callsBefore + 1)
    assert.deepEqual(after.terminals, before.terminals)
    assert.deepEqual(after.workspace, before.workspace)
    assert.deepEqual(after.active, before.active)
    assert.equal(
      await js(focused('p0123456789ab')),
      false,
      'row click must not silently open a different terminal',
    )
    await capture(`${row.id}-refusal-toast.png`)
    mark(`${row.title}:production-inbox-row-error-toast-no-new-tab-terminal-or-spawn`)
  }
  assert.deepEqual(backendSpawns, [])
  assert.deepEqual(denied, [])
  assert.deepEqual(errors, [])
  assert.equal(process.versions.electron.split('.')[0], '43')
  await win.webContents.debugger.sendCommand('Page.stopScreencast')
  assert(frames.length > 10, 'record actual interaction frames, never a screenshot montage')
  writeFileSync(join(evidence, 'screencast.json'), JSON.stringify(frames, null, 2))
  const rendererState = await state()
  await js('window.smoke542.dispose()')
  await host.stopAll()
  assert.equal(contexts.size, 0)
  assert.equal(inboxes.size, 0)
  mark('production-renderer-and-main-plugin-lifetimes-disposed')
  writeFileSync(
    join(evidence, 'result.json'),
    JSON.stringify(
      {
        ok: true,
        issue: 542,
        baseline: '40729561',
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
        checks,
        captures,
        networkDenied: denied,
        rendererErrors: errors,
        backendSpawns,
        rowMatrixAgentOpenCalls: rowOpenBaseline,
        agentOpenCalls: opens(),
        operations,
        lifecycle,
        notifierInvocation:
          'actual production createPluginHost admitted notice.onClick invoked by driver; native OS notification UI not clicked',
        fixtureScope:
          'real Electron, production host/inbox/agent.open policy/renderer lifecycle and rows/session views/xterm; controlled vault snapshots and existing PTY adapters, no provider processes or inference',
        videoMode: 'Page.startScreencast actual interactions with Chromium timestamps',
        isolatedRoots,
        rendererState,
        frameCount: frames.length,
      },
      null,
      2,
    ),
  )
  win.destroy()
  app.quit()
}

void run().catch((error: unknown) => {
  mkdirSync(evidence, { recursive: true })
  writeFileSync(
    join(evidence, 'failure.txt'),
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  )
  console.error(error)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
    win.destroy()
  }
  app.exit(1)
})
