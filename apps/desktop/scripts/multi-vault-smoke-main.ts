import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createVaultHost, type VaultHost } from '../src/main/vault/active-vault'
import { VaultRegistry } from '../src/main/vault/registry'
import { createCapabilityRegistry } from '../src/main/capabilities/registry'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import { createCoreServices, createUiReports } from '../src/main/capabilities/services'
import { VAULT_NAMESPACES, vaultCapabilities } from '../src/main/capabilities/vault-caps'
import { createMembersCache } from '../src/main/github/members-cache'
import { createBridgeServer, type BridgeServer } from '../src/main/bridge/server'
import { createCliTargetResolver } from '../src/main/bridge/cli-target'
import { createPluginHost } from '../src/main/plugin-host/host'
import { createRouter, type RouterDeps } from '../src/main/router'
import { registerIpc } from '../src/main/ipc'
import { startRegisteredVaults } from '../src/main/vault/startup'

const root = realpathSync(process.env.HOLI_176_ROOT!)
const evidence = process.env.HOLI_176_EVIDENCE!
assert(root && evidence, 'fixture paths required')
mkdirSync(join(root, 'profile'), { recursive: true })
app.setPath('userData', join(root, 'profile'))
const exec = promisify(execFile)
const checks: string[] = []
const A = 'smoke/vault-a'
const B = 'smoke/vault-b'
const roots = new Map<string, string>()
const origins = new Map<string, string>()
let host: VaultHost | undefined
let bridge: BridgeServer | undefined
let win: BrowserWindow | undefined
let stopPlugins: (() => Promise<void>) | undefined
const opens: string[] = []
const stops: string[] = []
const frames: { file: string; timestamp: number }[] = []
const frameWrites: Promise<void>[] = []
async function finishRecording() {
  if (!win?.webContents.debugger.isAttached()) return
  await win.webContents.debugger.sendCommand('Page.stopScreencast')
  await Promise.all(frameWrites)
  assert(frames.length > 1, 'actual interaction recording has frames')
  const lines = frames.flatMap((frame, index) => [
    `file '${frame.file}'`,
    ...(frames[index + 1] ? [`duration ${frames[index + 1]!.timestamp - frame.timestamp}`] : []),
  ])
  await writeFile(join(evidence, 'frames.ffconcat'), lines.join('\n'))
  await exec('ffmpeg', [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    join(evidence, 'frames.ffconcat'),
    '-vf',
    'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-r',
    '24',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    join(evidence, 'interaction.mp4'),
  ])
  win.webContents.debugger.detach()
}
const git = async (cwd: string, args: string[]) =>
  (await exec('git', ['-c', 'commit.gpgsign=false', ...args], { cwd })).stdout.trim()
const wait = async (label: string, predicate: () => Promise<boolean>, limit = 30_000) => {
  const end = Date.now() + limit
  while (Date.now() < end) {
    if (await predicate()) {
      checks.push(label)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`Timed out after ${limit}ms: ${label}`)
}
const published = (remote: string, path: string) =>
  git(origins.get(remote)!, ['show', `refs/heads/main:${path}`]).catch(() => '')
const evaluate = <T>(expression: string): Promise<T> =>
  win!.webContents.executeJavaScript(expression)
async function select(remote: string) {
  const point = await evaluate<{ x: number; y: number }>(`(() => {
    const button = [...document.querySelectorAll('button')].find(el => el.textContent === ${JSON.stringify(remote)});
    const rect = button.getBoundingClientRect(); return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)};
  })()`)
  await win!.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...point,
  })
  await win!.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...point,
  })
  await wait(
    `native click displays ${remote}`,
    async () =>
      host!.active()?.remote === remote &&
      (await evaluate('window.multiVault.state().ready')) === remote,
  )
}
async function main() {
  await app.whenReady()
  for (const remote of [A, B]) {
    const base = join(root, remote.split('/')[1]!)
    await mkdir(base, { recursive: true })
    const origin = join(base, 'origin.git')
    await exec('git', ['init', '--bare', '-b', 'main', origin])
    const clone = join(base, 'vault')
    await exec('git', ['clone', origin, clone])
    await git(clone, ['config', 'user.name', 'Holi fixture'])
    await git(clone, ['config', 'user.email', 'fixture@holi.invalid'])
    await writeFile(join(clone, 'README.md'), `# ${remote}\n`)
    await writeFile(join(clone, '.gitignore'), '.holi/state/\n*.local.*\n')
    await git(clone, ['add', '-A'])
    await git(clone, ['commit', '-m', 'seed'])
    await git(clone, ['push', '-u', 'origin', 'main'])
    roots.set(remote, clone)
    origins.set(remote, origin)
  }
  const registry = new VaultRegistry(join(root, 'vaults.json'))
  for (const [remote, path] of roots)
    await registry.add({ remote, path, name: remote, lastOpenedAt: '2026-01-01T00:00:00Z' })
  const capabilities = createCapabilityRegistry()
  const send = (channel: string, value: unknown) => win?.webContents.send(channel, value)
  const pluginHost = createPluginHost({
    plugins: [
      {
        info: { id: 'proof', label: 'Proof', default: true },
        activate(ctx) {
          opens.push(ctx.remote)
          return () => {
            stops.push(ctx.remote)
          }
        },
      },
    ],
    registry: capabilities,
    userData: join(root, 'profile'),
    coreSeeds: [],
    active: () => host?.active() ?? null,
    rootFor: async (remote) => roots.get(remote) ?? null,
    events: { send, listen: () => () => {}, liveRemote: () => host?.active()?.remote ?? null },
    openAppDoor: (opener, remote) => capabilityHost.openAppDoor(opener, remote),
    route: (path, route, remote) => bridge!.route(path, route, remote),
    binDir: () => root,
    githubToken: () => null,
    frameOrigin: () => () => {},
    notify: () => false,
    focused: () => false,
  })
  stopPlugins = () => pluginHost.stopAll()
  host = createVaultHost({
    registry,
    activity: (entry) => console.log('[sync]', entry.remote, entry.message),
    claims: async () => [],
    timings: {
      rescanDebounceMs: 40,
      commitQuietMs: 120,
      pushQuietMs: 160,
      healIntervalMs: 4_000,
      pullIntervalMs: 5_000,
      pushBudgetMs: 500,
    },
    onSnapshot: (remote, snapshot) => send('vault:snapshot', { remote, snapshot }),
    onSyncState: (remote, state) => send('vault:sync', { remote, state }),
    onHeldBack: (remote, files) => send('vault:heldback', { remote, files }),
    onCommitted: (remote, paths) => send('vault:committed', { remote, paths }),
    onLeave: async (remote) => {
      await pluginHost.stop(remote)
    },
  })
  const core = createCoreServices({
    get: (remote) => host!.get(remote),
    reports: createUiReports(),
    members: createMembersCache(async () => []),
  })
  capabilities.register(
    VAULT_NAMESPACES,
    vaultCapabilities({
      open: () => {},
      screenshot: async () => {
        throw new Error('not exercised')
      },
      updateSkills: async () => {
        throw new Error('not exercised')
      },
      skillsStatus: async () => {
        throw new Error('not exercised')
      },
    }),
  )
  const capabilityHost = createCapabilityHost({
    registry: capabilities,
    rootFor: async (remote) => roots.get(remote) ?? null,
    get: (remote) => host!.get(remote),
    core,
    pluginEnabled: async () => true,
    claims: async () => [],
  })
  const resolver = createCliTargetResolver(
    registry,
    async (remote, path) => host!.get(remote)?.root === path,
  )
  const token = randomBytes(32).toString('hex')
  bridge = createBridgeServer({
    cli: {
      dispatch: capabilityHost.dispatch,
      commands: (remote) => capabilities.commands(remote),
      rootFor: async (remote) => roots.get(remote) ?? null,
      machine: {
        token: () => token,
        listVaults: () => resolver.list(),
        resolveTarget: async (selector, cwd) => {
          const target = await resolver.resolve(selector, cwd)
          return target === null
            ? null
            : { remote: target.entry.remote, root: target.entry.path, live: target.live }
        },
      },
    },
  })
  await bridge.start()
  const cli = async (argv: string[], input?: string) => {
    const body = new URLSearchParams(argv.map((arg) => ['argv', arg]))
    body.set('cwd', root)
    if (input !== undefined) body.set('stdin', input)
    const response = await fetch(`http://127.0.0.1:${bridge!.port()}/cli`, {
      method: 'POST',
      headers: { 'x-holi-cli-token': token },
      body,
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    return JSON.parse(text) as { pushed: boolean; revision: string; phase: string }
  }
  const router = createRouter({
    registry,
    host,
    capabilities: capabilityHost,
    plugins: pluginHost,
    seed: (path) => pluginHost.seed(path),
    vaultRoot: root,
    userData: join(root, 'profile'),
    session: {
      token: () => null,
      viewer: null,
      generation: 0,
      onGenerationChange: () => () => {},
    } as unknown as RouterDeps['session'],
    opened: (remote) => pluginHost.snapshot(remote, host!.get(remote)!.snapshot()),
    openExternal: async () => {},
    showItemInFolder: () => {},
    trashItem: async () => {
      throw new Error('not exercised')
    },
  })
  registerIpc({
    router,
    rootFor: async (remote) => roots.get(remote) ?? null,
    authorizeSender: (event) =>
      event.sender === win?.webContents && event.senderFrame === win.webContents.mainFrame,
  })
  await startRegisteredVaults(
    await registry.list(),
    async (remote) => {
      await host!.withRuntime(
        remote,
        async (cold) => {
          if (cold) await pluginHost.seed(roots.get(remote)!)
        },
        async (runtime) => {
          await pluginHost.reconcile(runtime, 'open')
        },
      )
    },
    (_remote, error) => {
      throw error
    },
  )
  assert.equal(host.active(), null)
  checks.push('background startup opens both real runtimes without selecting')
  win = new BrowserWindow({
    width: 1050,
    height: 720,
    show: false,
    webPreferences: { preload: join(root, 'preload.cjs'), contextIsolation: true, sandbox: true },
  })
  win.webContents.on('console-message', (_event, _level, message) =>
    console.log('[renderer]', message),
  )
  win.webContents.on('preload-error', (_event, _path, error) => console.error('[preload]', error))
  await win.loadFile(join(root, 'renderer.html'))
  await wait('production renderer state ready', async () =>
    evaluate('Boolean(window.multiVault) && document.querySelectorAll("button").length === 2'),
  )
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Page.enable')
  win.webContents.debugger.on('message', (_event, method, params) => {
    if (method !== 'Page.screencastFrame') return
    const file = `frame-${String(frames.length).padStart(5, '0')}.jpg`
    frames.push({ file, timestamp: params.metadata.timestamp })
    frameWrites.push(writeFile(join(evidence, file), Buffer.from(params.data, 'base64')))
    void win!.webContents.debugger.sendCommand('Page.screencastFrameAck', {
      sessionId: params.sessionId,
    })
  })
  await win.webContents.debugger.sendCommand('Page.startScreencast', {
    format: 'jpeg',
    quality: 70,
    everyNthFrame: 1,
  })
  await select(A)
  const a = host.get(A)!
  await evaluate(`window.multiVault.editBuffer('Preserved A buffer\\n')`)
  await select(B)
  assert.equal(await readFile(join(roots.get(A)!, 'buffer.md'), 'utf8'), 'Preserved A buffer\n')
  await evaluate(`window.multiVault.editBuffer('Retained B buffer', true)`)
  assert.equal(
    await evaluate(`window.multiVault.select(${JSON.stringify(A)}).then(() => false, () => true)`),
    true,
  )
  assert.equal(await evaluate('window.multiVault.state().remote'), B)
  assert.equal(await evaluate('window.multiVault.state().buffer'), 'Retained B buffer')
  await evaluate(`window.multiVault.editBuffer('Retained B buffer', false)`)
  checks.push('buffer-safe switching saves A; refused B flush retains text and selection')
  assert.equal(host.get(A), a)
  assert.equal(stops.length, 0)
  assert.deepEqual(new Set(opens), new Set([A, B]))
  checks.push('actual renderer switch retains runtimes and production plugin lifetimes')
  await writeFile(join(roots.get(A)!, 'background-a.md'), 'A background\n')
  await wait(
    'background A autosaves and pushes while B displayed',
    async () => (await published(A, 'background-a.md')) === 'A background',
  )
  assert.equal(await evaluate('window.multiVault.state().remote'), B)
  assert.equal(await evaluate('window.multiVault.state().paths.includes("background-a.md")'), false)
  checks.push('remote A snapshot and sync pushes cannot replace B display')
  await writeFile(join(roots.get(B)!, 'background-b.md'), 'B background\n')
  await wait(
    'displayed B publishes independently',
    async () => (await published(B, 'background-b.md')) === 'B background',
  )
  const teammate = join(root, 'teammate')
  await exec('git', ['clone', origins.get(A)!, teammate])
  await git(teammate, ['config', 'user.name', 'Fixture teammate'])
  await git(teammate, ['config', 'user.email', 'teammate@holi.invalid'])
  await writeFile(join(teammate, 'teammate.md'), 'teammate\n')
  await git(teammate, ['add', '-A'])
  await git(teammate, ['commit', '-m', 'teammate'])
  await git(teammate, ['push'])
  await wait(
    'background A pulls real teammate commit',
    async () =>
      (await readFile(join(roots.get(A)!, 'teammate.md'), 'utf8').catch(() => '')) === 'teammate\n',
  )
  // The file arriving proves the merge landed, not that its pull has left the
  // busy state. CLI settlement explicitly refuses while a pull is in flight.
  await wait('background A finishes teammate pull', async () => a.syncState().kind !== 'pulling')
  let delivered = await cli(
    ['docs', 'create', 'cli-note.md', '--vault', A, '--json'],
    'CLI background\n',
  )
  await wait('CLI settlement verifies origin receipt', async () => {
    if (!delivered.pushed)
      delivered = await cli([
        'docs',
        'settle',
        'cli-note.md',
        createHash('sha256').update('CLI background\n').digest('hex'),
        '--vault',
        A,
        '--json',
      ])
    return delivered.pushed
  })
  assert.equal(host.active()?.remote, B)
  assert.equal(await published(A, 'cli-note.md'), 'CLI background')
  checks.push('machine CLI from outside clones writes and settles A without switching B')
  await git(roots.get(A)!, ['remote', 'set-url', 'origin', join(root, 'missing.git')])
  await writeFile(join(roots.get(A)!, 'pending.md'), 'pending A\n')
  await writeFile(join(roots.get(B)!, 'independent.md'), 'B independent\n')
  await wait(
    'B publishes while A origin unavailable',
    async () => (await published(B, 'independent.md')) === 'B independent',
  )
  await git(roots.get(A)!, ['remote', 'set-url', 'origin', origins.get(A)!])
  await a.commitNow()
  await a.pushNow()
  await wait(
    'A recovers pending publication',
    async () => (await published(A, 'pending.md')) === 'pending A',
  )
  await select(A)
  await wait('switch replays authoritative A snapshot', async () =>
    evaluate('window.multiVault.state().paths.includes("background-a.md")'),
  )
  await writeFile(join(evidence, 'two-vaults.png'), (await win.webContents.capturePage()).toPNG())
  await select(B)
  await finishRecording()
  await router.createCaller({}).vaults.remove({ remote: A })
  assert.equal(host.get(A), null)
  assert(host.get(B))
  assert(stops.includes(A))
  checks.push('router deregistration drains only addressed runtime and plugin')
  await host.closeAll()
  assert.equal(host.get(B), null)
  assert(stops.includes(B))
  checks.push('all-vault close drains remaining runtime and plugin')
}
let failed: unknown
void main()
  .catch(async (error) => {
    failed = error
    console.error(error)
    for (const [remote, path] of roots) {
      console.error(
        '[runtime]',
        remote,
        JSON.stringify(host?.get(remote)?.syncState()),
        await git(path, ['status', '--porcelain=v2', '--branch']),
        await git(path, ['remote', '-v']),
      )
    }
    if (win) {
      console.error(
        '[fixture state]',
        await evaluate('JSON.stringify(window.multiVault?.state())').catch(String),
      )
      await writeFile(join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
    }
  })
  .finally(async () => {
    const cleanupErrors: string[] = []
    await host?.closeAll().catch((error) => cleanupErrors.push(String(error)))
    await stopPlugins?.().catch((error) => cleanupErrors.push(String(error)))
    await bridge?.stop().catch((error) => cleanupErrors.push(String(error)))
    await Promise.all(frameWrites)
    await writeFile(
      join(evidence, 'result.json'),
      JSON.stringify(
        {
          ok: !failed && cleanupErrors.length === 0,
          checks,
          error: failed ? String(failed) : null,
          cleanupErrors,
          electron: process.versions.electron,
        },
        null,
        2,
      ),
    )
    app.exit(failed || cleanupErrors.length ? 1 : 0)
  })
