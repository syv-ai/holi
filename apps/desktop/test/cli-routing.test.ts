import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installHoliCli } from '../src/main/bridge/cli'
import { publishCliEndpoint, type CliEndpoint } from '../src/main/bridge/cli-endpoint'
import { createCliTargetResolver } from '../src/main/bridge/cli-target'
import { createBridgeServer, type BridgeServer } from '../src/main/bridge/server'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import { cap, createCapabilityRegistry } from '../src/main/capabilities/registry'
import { noCoreServices } from '../src/main/capabilities/services'
import { VAULT_NAMESPACES, vaultCapabilities } from '../src/main/capabilities/vault-caps'
import { VaultRegistry } from '../src/main/vault/registry'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('generated CLI registry routing', () => {
  let dir: string, a: string, b: string, bin: string
  let endpoint: CliEndpoint, server: BridgeServer, registry: VaultRegistry
  let unregisterA: (() => void) | undefined
  let live: { remote: string; root: string } | null
  let pause: (() => Promise<void>) | null
  const invoked = vi.fn()

  function run(args: string[], cwd = dir, input = '') {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(
        bin,
        args,
        { cwd, env: { PATH: process.env.PATH, ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' } },
        (error, stdout, stderr) => {
          resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr })
        },
      )
      child.stdin?.end(input)
    })
  }

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'holi-cli-routing-')))
    a = join(dir, 'a')
    b = join(dir, 'b')
    await Promise.all([mkdir(a), mkdir(b)])
    registry = new VaultRegistry(join(dir, 'registry.json'))
    for (const [name, path] of [
      ['a', a],
      ['b', b],
    ] as const) {
      execFileSync('git', ['init', '-q', path])
      await registry.add({ remote: `owner/${name}`, name, path, lastOpenedAt: '2026-01-01' })
      await writeFile(join(path, 'note.md'), `# ${name}\n`)
    }
    await mkdir(join(a, 'notes', 'nested'), { recursive: true })
    live = { remote: 'owner/b', root: b }
    pause = null
    invoked.mockClear()
    const capabilities = createCapabilityRegistry()
    capabilities.register(
      VAULT_NAMESPACES,
      vaultCapabilities({
        updateSkills: async () => ({ summary: '', conflicts: null }),
        pendingSkills: async () => [],
        open: () => invoked(),
        screenshot: async () => new Uint8Array(),
      }),
    )
    for (const remote of ['owner/a', 'owner/b']) {
      const unregister = capabilities.register(
        ['probe'],
        {
          'probe.read': cap({
            doors: ['cli'],
            cli: { args: [], summary: `read ${remote} plugin context` },
            params: () => null,
            run: async (ctx) => {
              invoked()
              return `${ctx.remote}: ${remote}`
            },
            text: (value) => value,
          }),
          'probe.check': cap({
            doors: ['cli'],
            cli: {
              args: [],
              values: ['query'],
              flags: ['flag'],
              summary: `check ${remote} plugin context`,
            },
            params: (params) => params as Record<string, string>,
            run: async (ctx, params) => {
              invoked()
              return `${ctx.remote}: ${remote}: ${params.flag ?? ''}: ${params.query ?? ''}`
            },
            text: (value) => value,
          }),
        },
        'probe',
        remote,
      )
      if (remote === 'owner/a') unregisterA = unregister
    }
    const rootFor = async (remote: string) =>
      (await registry.list()).find((entry) => entry.remote === remote)?.path ?? null
    const host = createCapabilityHost({
      registry: capabilities,
      rootFor,
      active: () => null,
      core: noCoreServices,
      pluginEnabled: async () => {
        await pause?.()
        return true
      },
      claims: async () => [],
    })
    const targets = createCliTargetResolver(
      registry,
      (remote, root) => live?.remote === remote && live.root === root,
    )
    server = createBridgeServer({
      log: () => {},
      cli: {
        dispatch: host.dispatch,
        commands: (remote) => capabilities.commands(remote),
        rootFor,
        machine: {
          token: () => endpoint?.token ?? '',
          listVaults: () => targets.list(),
          resolveTarget: async (selector, cwd) => {
            const target = await targets.resolve(selector, cwd)
            return target === null
              ? null
              : { remote: target.entry.remote, root: target.entry.path, live: target.live }
          },
        },
      },
    })
    bin = await installHoliCli(dir)
    await server.start()
    endpoint = await publishCliEndpoint(join(dir, 'cli-endpoint.json'), server.port()!)
  })
  afterEach(async () => {
    await endpoint.dispose()
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('lists without a target and reads closed A while B remains displayed', async () => {
    const list = await run(['vault', 'list', '--json'])
    expect(list.code).toBe(0)
    expect(JSON.parse(list.stdout)).toEqual([
      { remote: 'owner/a', name: 'a', live: false },
      { remote: 'owner/b', name: 'b', live: true },
    ])
    const shown = live
    expect(await run(['docs', 'read', 'note.md', '--vault', 'OWNER/A'])).toMatchObject({
      code: 0,
      stdout: '# a\n\n',
    })
    const inspected = await run(['docs', 'inspect', 'note.md', '--vault=owner/a', '--json'])
    expect(inspected.code, inspected.stderr).toBe(0)
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      body: '# a\n',
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(await run(['docs', 'read', 'note.md'], join(a, 'notes', 'nested'))).toMatchObject({
      code: 0,
      stdout: '# a\n\n',
    })
    expect(live).toBe(shown)
  })
  it('uses scoped option metadata before resolving selector candidates', async () => {
    live = { remote: 'owner/a', root: a }
    expect(await run(['probe', 'check', '--flag', '--vault', 'owner/a'], b)).toMatchObject({
      code: 0,
      stdout: 'owner/a: owner/a: true: \n',
    })
    expect(
      await run(['probe', 'check', '--query=--vault=owner/b', '--vault=owner/a'], b),
    ).toMatchObject({ code: 0, stdout: 'owner/a: owner/a: : --vault=owner/b\n' })
    expect(await run(['probe', 'check', '--flag'], a)).toMatchObject({
      code: 0,
      stdout: 'owner/a: owner/a: true: \n',
    })
    expect(await run(['probe', 'read', '--query', '--', '--vault=owner/a'], b)).toMatchObject({
      code: 0,
      stdout: 'owner/a: owner/a\n',
    })
    expect(invoked).toHaveBeenCalledTimes(4)
  })

  it('never falls back to B for missing, unknown, or escaped cwd targets', async () => {
    expect(await run(['docs', 'read', 'note.md'])).toMatchObject({
      code: 2,
      stdout: '',
      stderr: expect.stringContaining('target required'),
    })
    expect(await run(['docs', 'read', 'note.md', '--vault=owner/missing'])).toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining('unknown vault'),
    })
    await symlink(dir, join(a, 'escape'))
    expect((await run(['docs', 'read', 'note.md'], join(a, 'escape'))).code).toBe(2)
    expect((await run(['--vault', 'owner/a', 'docs', 'read', 'note.md'])).code).toBe(2)
  })
  it('denies closed writes and plugin/UI actions before invoking them', async () => {
    expect(await run(['probe', 'read', '--vault', 'owner/a', '--help'])).toMatchObject({
      code: 0,
      stdout: expect.stringContaining('read owner/a plugin context'),
    })
    expect(await run(['probe', 'read', '--vault', 'owner/b', '--help'])).toMatchObject({
      code: 0,
      stdout: expect.stringContaining('read owner/b plugin context'),
    })
    for (const args of [
      ['docs', 'create', 'new.md'],
      ['docs', 'open', 'note.md'],
      ['probe', 'read'],
      ['skills', 'update'],
    ]) {
      const result = await run([...args, '--vault', 'owner/a'], dir, '# rejected\n')
      expect(result).toMatchObject({
        code: 1,
        stdout: '',
        stderr: expect.stringContaining('vault is closed'),
      })
    }
    expect(invoked).not.toHaveBeenCalled()
    expect(await readFile(join(a, 'new.md'), 'utf8').catch(() => null)).toBeNull()
    unregisterA?.()
    expect(await run(['probe', 'read', '--vault', 'owner/a'])).toMatchObject({
      code: 2,
      stdout: '',
      stderr: expect.stringContaining('no such command: probe read'),
    })
    expect(invoked).not.toHaveBeenCalled()
    live = { remote: 'owner/b', root: b }
    expect(await run(['probe', 'read', '--vault', 'owner/b'])).toMatchObject({
      code: 0,
      stdout: 'owner/b: owner/b\n',
    })
    expect(invoked).toHaveBeenCalledTimes(1)
  })
  it('writes accessible large-read spills only inside the addressed clone', async () => {
    const text = '# large\n' + 'a'.repeat(20_000)
    await writeFile(join(a, 'large.md'), text)
    const result = await run(['docs', 'read', 'large.md', '--vault=owner/a'])
    expect(result.code).toBe(0)
    const path = result.stdout.split('\n')[1]!.trim()
    expect(isAbsolute(path)).toBe(true)
    expect(path.startsWith(a + '/')).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(text)
  })
  it.each(['switch', 'remove', 'move'])(
    'refuses %s while enablement is pending',
    async (change) => {
      const started = deferred(),
        release = deferred()
      pause = async () => {
        started.resolve()
        await release.promise
      }
      const result = run(['probe', 'read', '--vault', 'owner/b'])
      await started.promise
      if (change === 'switch') live = { remote: 'owner/a', root: a }
      else if (change === 'remove') await registry.remove('owner/b')
      else {
        await registry.remove('owner/a')
        await registry.add({
          remote: 'owner/b',
          path: a,
          name: 'moved',
          lastOpenedAt: '2026-01-01',
        })
      }
      release.resolve()
      expect((await result).code).toBe(1)
      expect(invoked).not.toHaveBeenCalled()
    },
  )
})
