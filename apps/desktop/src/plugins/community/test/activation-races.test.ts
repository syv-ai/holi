import { existsSync } from 'node:fs'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

const pathResolution = vi.hoisted(() => ({
  target: null as string | null,
  entered: null as (() => void) | null,
  blocked: null as Promise<void> | null,
}))

vi.mock('@holi/shared/path-safety-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@holi/shared/path-safety-node')>()
  return {
    ...actual,
    resolveRelative: async (root: string, relative: string) => {
      if (relative === pathResolution.target) {
        pathResolution.entered?.()
        await pathResolution.blocked
      }
      return actual.resolveRelative(root, relative)
    },
  }
})
import * as pluginApi from '../../../main/plugin-api'
import type { CapabilityTable, PluginCtx } from '../../../main/plugin-api'
import { createCapabilityHost } from '../../../main/capabilities/dispatch'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { createPluginHost, type OpenVault } from '../../../main/plugin-host/host'
import { communityMain } from '../main'
import { communityOwner } from '../main/owner'
import type { Install } from '../main/store'
import { PLUGIN_COMMANDS_DIR, pluginServerOrigin } from '@holi/shared'
import { createFrameOrigins } from '../../../main/frame-origins'

const roots: string[] = []
const commandName = `holi-community-test-${process.pid}`
const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const manifest = (resist = false) => ({
  id: 'sample',
  name: 'Sample',
  version: '1.0.0',
  opens: ['page.md'],
  serve: [process.execPath, 'serve.cjs', '{port}', ...(resist ? ['resist'] : [])],
  bin: { [commandName]: 'bin/sample' },
})

type Activation = {
  root: string
  remote: string
  table: CapabilityTable
  events: unknown[]
  origins: Set<string>
  dispose: () => Promise<void>
}
async function harness() {
  const base = await mkdtemp(join(tmpdir(), 'holi-community-activation-'))
  roots.push(base)
  const userData = join(base, 'user-data')
  const owner = communityOwner({ userData })
  const activations: Activation[] = []
  const frameOrigins = createFrameOrigins()
  for (const [name, remote] of [
    ['a', 'owner/vault-a'],
    ['b', 'owner/vault-b'],
  ] as const) {
    const root = join(base, `vault-${name}`)
    await mkdir(join(root, '.holi/settings'), { recursive: true })
    await writeFile(
      join(root, '.holi/settings/plugins.yaml'),
      'plugins:\n  community: true\n  sample: true\n',
    )
    await writeFile(join(root, 'page.md'), '# Page\n')
    const events: unknown[] = []
    const origins = new Set<string>()
    let table!: CapabilityTable
    const disposeResult = await communityMain.activate!({
      userData,
      root,
      remote,
      githubToken: null,
      register: (_namespaces: readonly string[], registered: CapabilityTable) => {
        table = registered
        return () => {}
      },
      emit: (_target: string, name: string, payload: unknown) => events.push({ name, payload }),
      frameOrigin: (origin: string) => {
        origins.add(origin)
        const release = frameOrigins.acquire(origin)
        return () => {
          release()
          origins.delete(origin)
        }
      },
      onSnapshot: () => () => {},
    } as unknown as PluginCtx)
    const dispose = async () => {
      await disposeResult?.()
    }
    disposals.push(dispose)
    activations.push({ root, remote, table, events, origins, dispose })
  }
  const pluginDir = await serverFixture(base)
  const call = async (activation: Activation, name: string, params: unknown = {}) => {
    const entry = activation.table[name] as unknown as {
      params(raw: unknown): unknown
      run(ctx: unknown, params: unknown): Promise<unknown>
    }
    return entry.run(
      { root: activation.root, remote: activation.remote } as unknown,
      entry.params(params),
    )
  }
  await call(activations[0]!, 'community.installFolder', { folder: pluginDir })
  await call(activations[0]!, 'community.setup', { id: 'sample' })
  return { base, userData, owner, activations, pluginDir, call, frameOrigins }
}

async function serverFixture(base: string) {
  const pluginDir = join(base, 'plugin')
  await mkdir(join(pluginDir, 'bin'), { recursive: true })
  await writeFile(join(pluginDir, 'bin/sample'), '#!/bin/sh\necho sample\n')
  await chmod(join(pluginDir, 'bin/sample'), 0o755)
  await writeFile(
    join(pluginDir, 'serve.cjs'),
    "const h=require('node:http');const s=h.createServer((q,r)=>r.end('ok'));s.listen(Number(process.argv[2]),'127.0.0.1');if(process.argv.includes('resist'))process.on('SIGTERM',()=>{});",
  )
  await writeFile(join(pluginDir, 'holi-plugin.json'), JSON.stringify(manifest()))
  return pluginDir
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function hostedRaceHarness() {
  const base = await mkdtemp(join(tmpdir(), 'holi-community-host-race-'))
  roots.push(base)
  const userData = join(base, 'user-data')
  const owner = communityOwner({ userData })
  const a = { root: join(base, 'vault-a'), remote: 'owner/vault-a' }
  const b = { root: join(base, 'vault-b'), remote: 'owner/vault-b' }
  const rootFor = async (remote: string) =>
    [a, b].find((vault) => vault.remote === remote)?.root ?? null
  const contexts = new Map<string, PluginCtx>()
  const registry = createCapabilityRegistry()
  const frameOrigins = createFrameOrigins()
  const dependentDisposing = deferred()
  const releaseDependent = deferred()
  const communityDisposing = vi.fn()
  const idle = () => () => {}
  const host = createPluginHost({
    plugins: [
      {
        ...communityMain,
        async activate(ctx) {
          contexts.set(ctx.remote, ctx)
          const dispose = await communityMain.activate!(ctx)
          return async () => {
            communityDisposing(ctx)
            await dispose?.()
          }
        },
      },
      {
        // The host revokes community before this dependent's disposer runs.
        info: { id: 'hold-stop', label: 'Hold stop', default: true, requires: ['community'] },
        activate: (ctx) => async () => {
          if (ctx.remote !== a.remote) return
          dependentDisposing.resolve()
          await releaseDependent.promise
        },
      },
    ],
    registry,
    userData,
    coreSeeds: [],
    active: () => null,
    rootFor,
    events: { send() {}, listen: idle, liveRemote: () => null },
    openAppDoor: () => {
      throw new Error('unexpected app door')
    },
    route: idle,
    binDir: () => '',
    githubToken: () => null,
    frameOrigin: frameOrigins.acquire,
    notify: () => false,
    focused: () => false,
  })
  disposals.push(async () => {
    releaseDependent.resolve()
    await host.stopAll()
  })
  const caps = createCapabilityHost({
    registry,
    rootFor,
    get: (_remote) => null,
    core: noCoreServices,
    pluginEnabled: async (id, root, allowDrain) => (await host.serving(root, allowDrain)).has(id),
    claims: async () => [],
  })
  const call = async (remote: string, name: string, params: unknown) =>
    (await caps.dispatch({ door: 'ui', remote, name, params })).value
  for (const target of [a, b]) {
    await mkdir(join(target.root, '.holi/settings'), { recursive: true })
    await writeFile(
      join(target.root, '.holi/settings/plugins.yaml'),
      'plugins:\n  community: true\n  sample: true\n' +
        (target === a ? '  setup-sample: true\n' : ''),
    )
    await writeFile(join(target.root, 'page.md'), '# Page\n')
    const vault: OpenVault = {
      ...target,
      pause() {},
      resume() {},
      drainSync: async () => {},
      commitNow: async () => null,
      repo: { head: async () => null },
    }
    await host.reconcile(vault, 'open')
  }
  const folder = await serverFixture(base)
  await call(a.remote, 'community.installFolder', { folder })
  await call(a.remote, 'community.setup', { id: 'sample' })
  const setupFolder = join(base, 'setup-plugin')
  await mkdir(setupFolder)
  await writeFile(join(setupFolder, 'setup.cjs'), 'setInterval(() => {}, 1000)')
  await writeFile(
    join(setupFolder, 'holi-plugin.json'),
    JSON.stringify({
      id: 'setup-sample',
      name: 'Setup sample',
      version: '1.0.0',
      skills: [],
      setup: [process.execPath, 'setup.cjs', '{vault}'],
    }),
  )
  await call(a.remote, 'community.installFolder', { folder: setupFolder })
  return {
    a,
    b,
    owner,
    host,
    call,
    contexts,
    frameOrigins,
    dependentDisposing,
    releaseDependent,
    communityDisposing,
  }
}

const acquire = (h: Awaited<ReturnType<typeof harness>>, a: Activation) =>
  h.call(a, 'community.acquire', { path: 'page.md' }) as Promise<{ port: number; lease: string }>
const fetchOrigin = async (port: number) => (await fetch(`http://127.0.0.1:${port}/`)).text()
const waitFor = async (predicate: () => boolean, message: string) => {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('production community activation races', () => {
  test('releases actual server origins without revoking duplicate or replacement owners', async () => {
    const h = await harness()
    const a = await acquire(h, h.activations[0]!)
    const b = await acquire(h, h.activations[1]!)
    const originA = pluginServerOrigin(a.port)
    const originB = pluginServerOrigin(b.port)
    expect(h.frameOrigins.origins.has(originA)).toBe(true)
    expect(h.frameOrigins.origins.has(originB)).toBe(true)
    const duplicate = h.frameOrigins.acquire(originA)
    await h.activations[0]!.dispose()
    expect(h.frameOrigins.origins.has(originA)).toBe(true)
    expect(h.frameOrigins.origins.has(originB)).toBe(true)
    expect(await fetchOrigin(b.port)).toBe('ok')
    duplicate()
    expect(h.frameOrigins.origins.has(originA)).toBe(false)
    const replacement = h.frameOrigins.acquire(originA)
    duplicate()
    await h.call(h.activations[0]!, 'community.release', { lease: a.lease }).catch(() => {})
    expect(h.frameOrigins.origins.has(originA)).toBe(true)
    expect(h.frameOrigins.origins.has(originB)).toBe(true)
    replacement()
    await h.call(h.activations[1]!, 'community.release', { lease: b.lease })
    expect(h.frameOrigins.origins.size).toBe(0)
  })

  test('isolates simultaneous vault servers and fences foreign, old, and duplicate leases', async () => {
    const h = await harness()
    const [a, b] = await Promise.all([acquire(h, h.activations[0]!), acquire(h, h.activations[1]!)])
    expect(a.port).not.toBe(b.port)
    const originB = [...h.activations[1]!.origins][0]
    expect(originB).toContain(String(b.port))
    await h.call(h.activations[0]!, 'community.release', { lease: a.lease })
    expect(await fetchOrigin(b.port)).toBe('ok')
    expect(await h.call(h.activations[1]!, 'community.path', { id: 'sample' })).toBe(h.pluginDir)
    await h.call(h.activations[0]!, 'community.release', { lease: b.lease })
    await h.call(h.activations[1]!, 'community.release', { lease: a.lease })
    expect(await fetchOrigin(b.port)).toBe('ok')
    const replacement = await acquire(h, h.activations[0]!)
    await h.call(h.activations[0]!, 'community.release', { lease: a.lease })
    expect(await fetchOrigin(replacement.port)).toBe('ok')
    await h.call(h.activations[0]!, 'community.release', { lease: replacement.lease })
    await h.activations[0]!.dispose()
    expect(await fetchOrigin(b.port)).toBe('ok')
    expect(h.activations[1]!.origins.has(originB!)).toBe(true)
    expect(await readlink(join(h.activations[1]!.root, PLUGIN_COMMANDS_DIR, commandName))).toBe(
      await realpath(join(h.pluginDir, 'bin/sample')),
    )
    await h.call(h.activations[1]!, 'community.release', { lease: b.lease })
  })

  test('waits for resistant child exit before removing its install and command links', async () => {
    const h = await harness()
    await writeFile(join(h.pluginDir, 'holi-plugin.json'), JSON.stringify(manifest(true)))
    await h.call(h.activations[0]!, 'community.installFolder', { folder: h.pluginDir })
    await h.call(h.activations[0]!, 'community.setup', { id: 'sample' })
    const commit = 'a'.repeat(40)
    const devInstall = (await h.owner.store.get('sample'))!
    const releaseDir = h.owner.store.releaseDir('sample', commit)
    await mkdir(releaseDir, { recursive: true })
    await cp(h.pluginDir, releaseDir, { recursive: true })
    const releaseInstall: Install = {
      ...devInstall,
      source: { kind: 'release', repo: 'owner/sample', path: '', tag: 'v1.0.0', commit },
      setup: 'ok',
    }
    await h.owner.store.put(releaseInstall)
    await h.owner.consent.grant('sample', commit)
    await h.call(h.activations[0]!, 'community.setup', { id: 'sample' })
    const lease = await acquire(h, h.activations[0]!)
    for (const activation of h.activations) {
      expect(await h.call(activation, 'community.list')).toMatchObject([
        { id: 'sample', status: 'ready', on: true, running: true },
      ])
      expect(await readlink(join(activation.root, PLUGIN_COMMANDS_DIR, commandName))).toBe(
        await realpath(join(releaseDir, 'bin/sample')),
      )
    }
    const codePath = (await h.call(h.activations[0]!, 'community.path', { id: 'sample' })) as string
    const releasing = h.call(h.activations[0]!, 'community.release', { lease: lease.lease })
    await waitFor(() => h.activations[0]!.origins.size === 0, 'origin was not revoked')
    // Destructive removal must join the stop already started by the last release.
    const removeInstall = h.owner.store.remove
    let checkedRemoval = false
    h.owner.store.remove = async (id) => {
      await expect(fetchOrigin(lease.port)).rejects.toThrow()
      checkedRemoval = true
      return removeInstall(id)
    }
    try {
      let resolved = false
      const removing = h.call(h.activations[1]!, 'community.remove', { id: 'sample' }).then(() => {
        resolved = true
      })
      expect(resolved).toBe(false)
      expect(await readFile(join(codePath, 'holi-plugin.json'), 'utf8')).toContain('sample')
      await removing
      await releasing
      expect(checkedRemoval).toBe(true)
    } finally {
      h.owner.store.remove = removeInstall
    }
    expect(await h.owner.store.get('sample')).toBeNull()
    expect(existsSync(join(h.userData, 'plugins', 'sample'))).toBe(false)
    expect(h.activations.every((activation) => activation.origins.size === 0)).toBe(true)
    for (const activation of h.activations) {
      await expect(
        readlink(join(activation.root, PLUGIN_COMMANDS_DIR, commandName)),
      ).rejects.toThrow()
      expect(await h.call(activation, 'community.list')).toEqual([])
    }
    await h.call(h.activations[0]!, 'community.release', { lease: lease.lease })
  }, 12_000)

  test('reruns setup invalidation into both remotes, then admits a fresh server only', async () => {
    const h = await harness()
    const first = await acquire(h, h.activations[0]!)
    const second = await acquire(h, h.activations[1]!)
    const priorEventCounts = h.activations.map((activation) => activation.events.length)
    await h.call(h.activations[1]!, 'community.setup', { id: 'sample' })
    for (const activation of h.activations) {
      const added = activation.events.slice(
        priorEventCounts[h.activations.indexOf(activation)]!,
      ) as { name: string; payload: { id: string; state: { state: string } } }[]
      expect(
        added.some(
          (event) =>
            event.name === 'server' &&
            event.payload.id === 'sample' &&
            event.payload.state.state === 'exited',
        ),
      ).toBe(true)
      expect(activation.origins.size).toBe(0)
    }
    const fresh = await acquire(h, h.activations[0]!)
    expect(await fetchOrigin(fresh.port)).toBe('ok')
    await h.call(h.activations[0]!, 'community.release', { lease: first.lease })
    expect(await fetchOrigin(fresh.port)).toBe('ok')
    await h.call(h.activations[0]!, 'community.release', { lease: fresh.lease })
    await h.call(h.activations[1]!, 'community.release', { lease: second.lease })
  })

  test('rejects a ready lease invalidated before final admission without changing install metadata', async () => {
    const h = await harness()
    let entered!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const supervisor = h.owner.supervisor
    const originalAcquire = supervisor.acquire.bind(supervisor)
    let hold = true
    supervisor.acquire = async (key, spec) => {
      const acquired = await originalAcquire(key, spec)
      if (hold) {
        hold = false
        entered()
        await blocked
      }
      return acquired
    }
    try {
      const pending = acquire(h, h.activations[0]!)
      await ready
      const before = await h.owner.store.get('sample')
      await h.call(h.activations[1]!, 'community.setup', { id: 'sample' })
      expect(await h.owner.store.get('sample')).toEqual(before)
      release()
      await expect(pending).rejects.toThrow(/changed while starting/)
      expect(h.activations[0]!.origins.size).toBe(0)
      const fresh = await acquire(h, h.activations[0]!)
      expect(await fetchOrigin(fresh.port)).toBe('ok')
      await h.call(h.activations[0]!, 'community.release', { lease: fresh.lease })
    } finally {
      release()
      supervisor.acquire = originalAcquire
    }
  })

  test('does not acquire a server when path resolution resumes after disposal', async () => {
    const h = await harness()
    let entered!: () => void
    let release!: () => void
    const resolving = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    pathResolution.target = 'page.md'
    pathResolution.entered = entered
    pathResolution.blocked = blocked
    try {
      const pending = acquire(h, h.activations[0]!)
      await resolving
      const closing = h.activations[0]!.dispose()
      release()
      await expect(pending).rejects.toThrow(/closed/)
      await closing
      expect(h.activations[0]!.origins.size).toBe(0)
      expect(h.owner.supervisor.state(`${h.activations[0]!.root}\\0sample\\0page.md`)).toBeNull()
    } finally {
      release()
      pathResolution.target = null
      pathResolution.entered = null
      pathResolution.blocked = null
    }
  })

  test('releases a server lease when final admission rejects after disposal', async () => {
    const h = await harness()
    let entered!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const supervisor = h.owner.supervisor
    const originalAcquire = supervisor.acquire.bind(supervisor)
    supervisor.acquire = async (key, spec) => {
      const acquired = await originalAcquire(key, spec)
      entered()
      await blocked
      return acquired
    }
    try {
      const pending = acquire(h, h.activations[0]!)
      await ready
      const closing = h.activations[0]!.dispose()
      release()
      await expect(pending).rejects.toThrow(/closed/)
      await closing
      expect(h.activations[0]!.origins.size).toBe(0)
      expect(supervisor.state(`${h.activations[0]!.root}\0sample\0page.md`)).toBeNull()
    } finally {
      release()
      supervisor.acquire = originalAcquire
    }
  })

  test('an aborted setup with inherited pipes kills its descendant and records failure for every vault', async () => {
    const h = await harness()
    const marker = join(h.pluginDir, 'setup-started')
    const childPid = join(h.pluginDir, 'child-pid')
    await writeFile(
      join(h.pluginDir, 'setup.cjs'),
      `const fs=require('node:fs');const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`fs=require('node:fs');fs.writeFileSync(${JSON.stringify(childPid)},String(process.pid));setInterval(()=>{},1000)`)}],{stdio:'inherit'});c.once('spawn',()=>{fs.writeFileSync(${JSON.stringify(marker)},'yes');process.exit(0)})`,
    )
    await writeFile(
      join(h.pluginDir, 'holi-plugin.json'),
      JSON.stringify({ ...manifest(), setup: [process.execPath, 'setup.cjs'] }),
    )
    await h.call(h.activations[0]!, 'community.installFolder', { folder: h.pluginDir })
    const commit = 'b'.repeat(40)
    const releaseDir = h.owner.store.releaseDir('sample', commit)
    await mkdir(releaseDir, { recursive: true })
    await cp(h.pluginDir, releaseDir, { recursive: true })
    const installed = (await h.owner.store.get('sample'))!
    await h.owner.store.put({
      ...installed,
      source: { kind: 'release', repo: 'owner/sample', path: '', tag: 'v1.0.0', commit },
      setup: 'ok',
    })
    await h.owner.consent.grant('sample', commit)
    const pending = h.call(h.activations[0]!, 'community.setup', { id: 'sample' })
    await waitFor(() => existsSync(marker), 'setup did not start')
    await waitFor(() => existsSync(childPid), 'setup descendant did not start')
    const pid = Number(await readFile(childPid, 'utf8'))
    const dispose = h.activations[0]!.dispose()
    await expect(pending).resolves.toBe(false)
    await dispose
    await waitFor(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, 'setup descendant survived disposal')
    const otherVault = h.activations[1]!
    expect(await h.call(otherVault, 'community.list')).toMatchObject([
      { id: 'sample', status: 'setup-failed', running: false },
    ])
    await expect(h.call(otherVault, 'community.path', { id: 'sample' })).rejects.toThrow()
    const eventsAfterDispose = h.activations[0]!.events.length
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(h.activations[0]!.events).toHaveLength(eventsAfterDispose)
    expect(h.activations[0]!.origins.size).toBe(0)
    await h.call(h.activations[1]!, 'community.remove', { id: 'sample' })
  })

  test('setup and late acquire are drained when their owning activation disposes', async () => {
    const h = await hostedRaceHarness()
    const original = h.contexts.get(h.a.remote)!
    const sibling = h.contexts.get(h.b.remote)!
    const supervisor = h.owner.supervisor
    const lateKey = `${original.root}\0sample\0page.md`
    const siblingKey = `${sibling.root}\0sample\0page.md`
    const beforeSpawnAdmission = deferred()
    const resumeAdmission = deferred()
    const admittedLateSpawn = vi.fn()
    const acquireServer = supervisor.acquire
    const serverSpy = vi.spyOn(supervisor, 'acquire').mockImplementation((key, spec, readmit) => {
      if (key !== lateKey) return acquireServer(key, spec, readmit)
      const authorize = spec.authorizeSpawn
      if (!authorize) throw new Error('missing post-port server authorization')
      return acquireServer(
        key,
        {
          ...spec,
          authorizeSpawn(runSpawn) {
            // Hold a preceding turn in the real FIFO. The next call queues
            // the original post-port authorization behind it.
            void h.owner.admit(async () => {
              beforeSpawnAdmission.resolve()
              await resumeAdmission.promise
            })
            return authorize(() => {
              admittedLateSpawn()
              return runSpawn()
            })
          },
        },
        readmit,
      )
    })

    const spawn = pluginApi.spawnOwnedProgram
    const setupSpawned = deferred()
    let setupChild: ReturnType<typeof spawn> | undefined
    const spawnSpy = vi
      .spyOn(pluginApi, 'spawnOwnedProgram')
      .mockImplementation((bin, args, opts) => {
        const child = spawn(bin, args, opts)
        if (args[0] === 'setup.cjs') {
          setupChild = child
          child.once('spawn', () => setupSpawned.resolve())
        }
        return child
      })
    const setupJoined = deferred<pluginApi.OwnedProgramResult>()
    const releaseSetupJoin = deferred()
    const join = pluginApi.joinOwnedProgram
    const joinSpy = vi
      .spyOn(pluginApi, 'joinOwnedProgram')
      .mockImplementation((child, platform) => {
        const completion = join(child, platform)
        if (child !== setupChild) return completion
        // Hold delivery of the exact child's real join, not a synthetic exit or receipt.
        return completion.then(async (result) => {
          setupJoined.resolve(result)
          await releaseSetupJoin.promise
          return result
        })
      })
    const callAcquire = (ctx: PluginCtx) =>
      h.call(ctx.remote, 'community.acquire', { path: 'page.md' }) as Promise<{
        port: number
        lease: string
      }>
    try {
      const setupFinished = vi.fn()
      const setup = h.call(original.remote, 'community.setup', { id: 'setup-sample' })
      void setup.then(setupFinished, setupFinished)
      await Promise.race([
        setupSpawned.promise,
        setup.then(() => {
          throw new Error('setup finished before admitting its root')
        }),
      ])
      expect(spawnSpy.mock.calls.map(([, args]) => args)).toEqual([['setup.cjs', original.root]])
      expect(original.activationSignal.aborted).toBe(false)

      const late = callAcquire(original)
      await Promise.race([
        beforeSpawnAdmission.promise,
        late.then(() => {
          throw new Error('late acquire bypassed post-port authorization')
        }),
      ])
      expect(supervisor.state(lateKey)).toMatchObject({ state: 'starting' })
      expect(spawnSpy).toHaveBeenCalledTimes(1)
      const stopFinished = vi.fn()
      const stopping = h.host.stop(original.remote)
      void stopping.then(stopFinished, stopFinished)
      await h.dependentDisposing.promise
      expect(original.activationSignal.aborted).toBe(true)
      expect(sibling.activationSignal.aborted).toBe(false)
      expect(h.communityDisposing).not.toHaveBeenCalled()

      resumeAdmission.resolve()
      await expect(late).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'community attachment is closed',
      })
      expect(admittedLateSpawn).not.toHaveBeenCalled()
      expect(spawnSpy).toHaveBeenCalledTimes(1)
      expect(supervisor.state(lateKey)).toBeNull()
      expect(h.frameOrigins.origins.size).toBe(0)

      // Revocation alone also stops the already-admitted setup root; the
      // community disposer has not run yet.
      await expect(setupJoined.promise).resolves.toMatchObject({
        code: null,
        signal: 'SIGKILL',
        error: null,
      })
      h.releaseDependent.resolve()
      // A fresh sibling acquire takes the same owner queue while A's disposer
      // and setup are still waiting on the admitted root's join.
      const beside = await callAcquire(sibling)
      expect(h.communityDisposing).toHaveBeenCalledExactlyOnceWith(original)
      expect(setupFinished).not.toHaveBeenCalled()
      expect(stopFinished).not.toHaveBeenCalled()
      expect(supervisor.state(siblingKey)).toMatchObject({ state: 'running', port: beside.port })
      expect([...h.frameOrigins.origins]).toEqual([pluginServerOrigin(beside.port)])
      expect(spawnSpy.mock.calls.map(([, args]) => args[0])).toEqual(['setup.cjs', 'serve.cjs'])
      expect(spawnSpy.mock.lastCall?.[2].env?.HOLI_VAULT_ROOT).toBe(sibling.root)

      releaseSetupJoin.resolve()
      await expect(setup).resolves.toBe(false)
      await expect(stopping).resolves.toBeUndefined()
      expect(h.contexts.get(original.remote)).toBe(original)
      expect(h.contexts.get(sibling.remote)).toBe(sibling)
      expect(await fetchOrigin(beside.port)).toBe('ok')
      await h.call(sibling.remote, 'community.release', { lease: beside.lease })
      expect(supervisor.state(siblingKey)).toBeNull()
      expect(h.frameOrigins.origins.size).toBe(0)
    } finally {
      resumeAdmission.resolve()
      releaseSetupJoin.resolve()
      h.releaseDependent.resolve()
      serverSpy.mockRestore()
      spawnSpy.mockRestore()
      joinSpy.mockRestore()
    }
  })
})
