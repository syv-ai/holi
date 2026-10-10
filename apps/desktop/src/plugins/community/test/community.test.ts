/**
 * Community plugins end to end on the main side, against a plugin repository
 * on disk: fetch a release, consent, set up, pin, then serve a file and stop
 * its server. The server is a tiny Node http server, as Prezzi's is a Vite one.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { CapabilityContext } from '../../../main/plugin-api'
import { communityCapabilities, listPlugins } from '../main/capabilities'
import { createConsentStore } from '../main/consent'
import { listVersions } from '../main/fetch'
import { createInstallStore } from '../main/store'
import { createSupervisor, type ServerState } from '../main/supervisor'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A server that listens on its `--port`, and with `--child` leaves a
 *  grandchild running, as a dev server's workers would. */
const SERVE = `
const http = require('node:http')
const { spawn } = require('node:child_process')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
if (process.argv.includes('--fail')) { console.error('no deck here'); process.exit(3) }
if (process.argv.includes('--child')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  require('node:fs').writeFileSync(process.env.GRANDCHILD_PID_FILE, String(child.pid))
}
http.createServer((req, res) => res.end('deck ' + process.env.HOLI_FILE)).listen(port, '127.0.0.1')
console.log('serving on ' + port)
`

let dir: string
let repoDir: string
let vault: string
let userData: string

async function makeRepo(serveArgs: string[] = []) {
  repoDir = join(dir, 'prezzi')
  await mkdir(repoDir, { recursive: true })
  await writeFile(join(repoDir, 'serve.cjs'), SERVE)
  await writeFile(
    join(repoDir, 'setup.cjs'),
    "require('node:fs').writeFileSync('ready', 'yes'); console.log('set up')",
  )
  await writeFile(
    join(repoDir, 'holi-plugin.json'),
    JSON.stringify({
      id: 'prezzi',
      name: 'Prezzi',
      version: '0.1.0',
      opens: ['slides.md'],
      setup: [process.execPath, 'setup.cjs'],
      serve: [process.execPath, 'serve.cjs', '{file}', '--port', '{port}', ...serveArgs],
      ignore: ['slides-export.pdf'],
    }),
  )
  git(repoDir, 'init', '-q', '-b', 'main')
  git(repoDir, 'add', '.')
  git(repoDir, '-c', 'user.name=Ada Holm', '-c', 'user.email=ada@syv.ai', 'commit', '-qm', 'plugin')
  git(repoDir, 'tag', 'v0.1.0')
  return git(repoDir, 'rev-parse', 'HEAD')
}

function setup(firstPort = 3940) {
  const events: { name: string; payload: unknown }[] = []
  const states: ServerState[] = []
  const origins = new Set<string>()
  const store = createInstallStore(userData)
  const consent = createConsentStore(join(userData, 'plugin-consent.json'))
  const supervisor = createSupervisor({
    firstPort,
    readyTimeoutMs: 10_000,
    graceMs: 500,
    onState: (_key, state) => states.push(state),
    frameOrigin: (origin) => {
      origins.add(origin)
      return () => void origins.delete(origin)
    },
  })
  const deps = {
    store,
    consent,
    supervisor,
    git: { url: () => repoDir, token: () => null },
    token: () => null,
    firstPartyIds: () => ['agent', 'pdf'],
    emit: (_remote: string, name: string, payload: unknown) => events.push({ name, payload }),
    bridgeScript: () => null,
    scratch: join(userData, 'plugins', '.staging'),
  }
  const table = communityCapabilities(deps)
  const ctx = { remote: 'syv-ai/decks', root: vault, bundle: null } as unknown as CapabilityContext
  const call = <K extends keyof typeof table>(name: K, params: unknown = {}) => {
    const entry = table[name] as unknown as {
      params(raw: unknown): unknown
      run(ctx: CapabilityContext, params: unknown): Promise<unknown>
    }
    return entry.run(ctx, entry.params(params)) as ReturnType<(typeof table)[K]['run']>
  }
  return { call, deps, events, states, origins, supervisor }
}

async function turnOn() {
  await mkdir(join(vault, '.holi/settings'), { recursive: true })
  await writeFile(
    join(vault, '.holi/settings/app.yaml'),
    'plugins:\n  community: true\n  prezzi: true\n',
  )
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-community-'))
  vault = join(dir, 'vault')
  userData = join(dir, 'userData')
  await mkdir(join(vault, 'decks/q4'), { recursive: true })
  await writeFile(join(vault, 'decks/q4/slides.md'), '# Q4\n')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('installing', () => {
  test('lists the released versions, newest first', async () => {
    await makeRepo()
    git(repoDir, 'tag', 'v0.10.0')
    git(repoDir, 'tag', 'v0.2.0-beta.1')
    git(repoDir, 'tag', 'not-a-version')
    expect(await listVersions('syv-ai/prezzi', { url: () => repoDir, token: () => null })).toEqual([
      '0.10.0',
      '0.2.0-beta.1',
      '0.1.0',
    ])
  })

  test('nothing runs before consent, and consent is to one commit', async () => {
    const commit = await makeRepo()
    const { call } = setup()
    const row = await call('community.install', { repo: 'syv-ai/prezzi', version: '0.1.0' })
    expect(row.status).toBe('needs-consent')
    expect(row.install).toMatchObject({ kind: 'release', commit })
    await expect(call('community.setup', { id: 'prezzi' })).rejects.toThrow(/agreed/)
    await expect(
      call('community.consent', { id: 'prezzi', commit: 'f'.repeat(40) }),
    ).rejects.toThrow()
    await call('community.consent', { id: 'prezzi', commit })
    expect((await call('community.list'))[0]!.status).toBe('needs-setup')
  })

  test('setup runs in the plugin folder and streams its output', async () => {
    const commit = await makeRepo()
    const { call, deps, events } = setup()
    await call('community.install', { repo: 'syv-ai/prezzi', version: '0.1.0' })
    await call('community.consent', { id: 'prezzi', commit })
    expect(await call('community.setup', { id: 'prezzi' })).toBe(true)
    const install = (await deps.store.get('prezzi'))!
    expect(existsSync(join(deps.store.codeDir(install), 'ready'))).toBe(true)
    expect(events.some((e) => (e.payload as { line: string }).line === 'set up')).toBe(true)
    expect((await call('community.list'))[0]!.status).toBe('ready')
  })

  test('refuses a release that takes a built-in plugin’s name', async () => {
    await makeRepo()
    const manifest = JSON.parse(await readFile(join(repoDir, 'holi-plugin.json'), 'utf8'))
    await writeFile(
      join(repoDir, 'holi-plugin.json'),
      JSON.stringify({ ...manifest, id: 'pdf', version: '0.2.0' }),
    )
    git(repoDir, '-c', 'user.name=Ada Holm', '-c', 'user.email=ada@syv.ai', 'commit', '-qam', 'pdf')
    git(repoDir, 'tag', 'v0.2.0')
    const { call } = setup()
    await expect(
      call('community.install', { repo: 'syv-ai/prezzi', version: '0.2.0' }),
    ).rejects.toThrow(/built into Holi/)
  })

  test('a pin offers the same commit to a machine without it', async () => {
    const commit = await makeRepo()
    const { call } = setup()
    await call('community.install', { repo: 'syv-ai/prezzi', version: '0.1.0' })
    await call('community.pin', { id: 'prezzi' })
    const pin = JSON.parse(
      await readFile(join(vault, '.holi/plugins/prezzi/manifest.json'), 'utf8'),
    )
    expect(pin).toMatchObject({ id: 'prezzi', repo: 'syv-ai/prezzi', commit })
    expect(await readFile(join(vault, '.gitignore'), 'utf8')).toContain('slides-export.pdf')

    await call('community.remove', { id: 'prezzi' })
    const [row] = await listPlugins(vault, setup().deps)
    expect(row).toMatchObject({ status: 'not-installed', pin: { commit } })
  })
})

describe('serving', () => {
  async function ready(serveArgs: string[] = [], firstPort?: number) {
    const commit = await makeRepo(serveArgs)
    const s = setup(firstPort)
    await turnOn()
    await s.call('community.install', { repo: 'syv-ai/prezzi', version: '0.1.0' })
    await s.call('community.consent', { id: 'prezzi', commit })
    await s.call('community.setup', { id: 'prezzi' })
    return s
  }

  test('a file the plugin opens gets one server, shared, framed while up', async () => {
    const { call, origins } = await ready()
    const a = await call('community.acquire', { path: 'decks/q4/slides.md' })
    const b = await call('community.acquire', { path: 'decks/q4/slides.md' })
    expect(b.port).toBe(a.port)
    const body = await (await fetch(`http://127.0.0.1:${a.port}/`)).text()
    expect(body).toContain(join('decks', 'q4', 'slides.md'))
    expect(origins).toEqual(new Set([`http://localhost:${a.port}`]))

    await call('community.release', { path: 'decks/q4/slides.md' })
    expect(await canConnect(a.port)).toBe(true)
    await call('community.release', { path: 'decks/q4/slides.md' })
    expect(await canConnect(a.port)).toBe(false)
    expect(origins.size).toBe(0)
  })

  test('stopping a server stops what it started', async () => {
    const pidFile = join(dir, 'grandchild.pid')
    process.env.GRANDCHILD_PID_FILE = pidFile
    try {
      const { call } = await ready(['--child'], 3960)
      await call('community.acquire', { path: 'decks/q4/slides.md' })
      const grandchild = Number(await readFile(pidFile, 'utf8'))
      expect(alive(grandchild)).toBe(true)
      await call('community.release', { path: 'decks/q4/slides.md' })
      await waitFor(() => !alive(grandchild))
    } finally {
      delete process.env.GRANDCHILD_PID_FILE
    }
  })

  test('a server that exits before it is ready fails with its log', async () => {
    const { call, states } = await ready(['--fail'], 3980)
    await expect(call('community.acquire', { path: 'decks/q4/slides.md' })).rejects.toThrow(
      /before it was ready/,
    )
    expect(states.at(-1)).toMatchObject({ state: 'failed', log: ['no deck here'] })
  })

  test('a plugin the vault has off serves nothing', async () => {
    const { call } = await ready()
    await writeFile(join(vault, '.holi/settings/app.yaml'), 'plugins:\n  community: true\n')
    await expect(call('community.acquire', { path: 'decks/q4/slides.md' })).rejects.toThrow(
      /no plugin opens/,
    )
  })
})

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}
