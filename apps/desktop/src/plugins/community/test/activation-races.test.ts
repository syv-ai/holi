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
import type { CapabilityTable, PluginCtx } from '../../../main/plugin-api'
import { communityMain } from '../main'
import { communityOwner } from '../main/owner'
import type { Install } from '../main/store'
import { PLUGIN_COMMANDS_DIR } from '@holi/shared'

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
        return () => origins.delete(origin)
      },
      onSnapshot: () => () => {},
    } as unknown as PluginCtx)
    const dispose = async () => {
      await disposeResult?.()
    }
    disposals.push(dispose)
    activations.push({ root, remote, table, events, origins, dispose })
  }
  const pluginDir = join(base, 'plugin')
  await mkdir(join(pluginDir, 'bin'), { recursive: true })
  await writeFile(join(pluginDir, 'bin/sample'), '#!/bin/sh\necho sample\n')
  await chmod(join(pluginDir, 'bin/sample'), 0o755)
  await writeFile(
    join(pluginDir, 'serve.cjs'),
    "const h=require('node:http');const s=h.createServer((q,r)=>r.end('ok'));s.listen(Number(process.argv[2]),'127.0.0.1');if(process.argv.includes('resist'))process.on('SIGTERM',()=>{});",
  )
  await writeFile(join(pluginDir, 'holi-plugin.json'), JSON.stringify(manifest()))
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
  return { base, userData, owner, activations, pluginDir, call }
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
    const h = await harness()
    let entered!: () => void
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const owner = h.owner
    const originalGet = owner.store.get
    let block = true
    owner.store.get = async (id) => {
      const value = await originalGet(id)
      if (block && id === 'sample') {
        block = false
        entered()
        await blocked
      }
      return value
    }
    const pending = acquire(h, h.activations[0]!)
    await barrier
    const dispose = h.activations[0]!.dispose()
    release()
    await expect(pending).rejects.toThrow()
    await dispose
    owner.store.get = originalGet
    expect(h.activations[0]!.origins.size).toBe(0)
    const eventsAfterDispose = h.activations[0]!.events.length
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(h.activations[0]!.events).toHaveLength(eventsAfterDispose)
    expect(h.activations[0]!.origins.size).toBe(0)
    await h.call(h.activations[1]!, 'community.remove', { id: 'sample' })
  })
})
