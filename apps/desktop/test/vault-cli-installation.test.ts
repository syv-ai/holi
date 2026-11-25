import { execFile } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { installHoliCli } from '../src/main/bridge/cli'
import { publishCliEndpoint } from '../src/main/bridge/cli-endpoint'
import { createCliTargetResolver } from '../src/main/bridge/cli-target'
import { createVaultCliInstallations } from '../src/main/bridge/vault-cli'
import { createBridgeServer } from '../src/main/bridge/server'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import { cap, createCapabilityRegistry } from '../src/main/capabilities/registry'
import { noCoreServices } from '../src/main/capabilities/services'
import { VaultRegistry } from '../src/main/vault/registry'

const exec = promisify(execFile)

it('binds a generated vault CLI despite cwd changes and refuses foreign selectors', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'holi-vault-cli-')))
  const registry = new VaultRegistry(join(dir, 'registry.json'))
  const capabilities = createCapabilityRegistry()
  const calls: string[] = []
  const roots = new Map<string, string>()
  let machine: Awaited<ReturnType<typeof publishCliEndpoint>> | undefined
  const targets = createCliTargetResolver(registry, () => true)
  const host = createCapabilityHost({
    registry: capabilities,
    rootFor: async (remote) => roots.get(remote) ?? null,
    get: () => null,
    core: noCoreServices,
    pluginEnabled: async () => true,
    claims: async () => [],
  })
  const server = createBridgeServer({
    log: () => {},
    cli: {
      dispatch: host.dispatch,
      commands: (remote) => capabilities.commands(remote),
      rootFor: async (remote) => roots.get(remote) ?? null,
      machine: {
        token: () => machine?.token ?? '',
        resolveTarget: async (selector, cwd) => {
          const target = await targets.resolve(selector, cwd)
          return (
            target && { remote: target.entry.remote, root: target.entry.path, live: target.live }
          )
        },
      },
    },
  })
  const installations = createVaultCliInstallations(dir, server, process.execPath)
  try {
    for (const [name, remote] of [
      ['a', 'Owner/Notes'],
      ['b', 'owner/b'],
    ]) {
      const root = join(dir, name)
      await mkdir(root)
      roots.set(remote, root)
      await registry.add({ remote, name, path: root, lastOpenedAt: '2026-01-01' })
      capabilities.register(
        ['probe'],
        {
          'probe.read': cap({
            doors: ['cli'],
            cli: { args: [], summary: 'report vault' },
            params: () => null,
            run: async (ctx) => {
              calls.push(ctx.remote)
              return ctx.remote
            },
            text: (value) => value,
          }),
        },
        'probe',
        remote,
      )
      // Real legacy vault credentials make the baseline exercise the CWD patch,
      // not a missing-credential or missing-module setup failure.
      await mkdir(join(root, '.holi', 'state'), { recursive: true })
      await writeFile(join(root, '.holi', 'vault'), remote)
    }
    await server.start()
    machine = await publishCliEndpoint(join(dir, 'cli-endpoint.json'), server.port()!)
    for (const [remote, root] of roots)
      await writeFile(
        join(root, '.holi/state/bridge.local.env'),
        `HOLI_BRIDGE_PORT=${server.port()}\nHOLI_BRIDGE_TOKEN=${server.tokenForVault(remote)}\n`,
      )
    const human = await installHoliCli(dir)
    const [binDir, sameBin] = await Promise.all([
      installations.forRemote('Owner/Notes'),
      installations.forRemote('owner/notes'),
    ])
    expect(sameBin).toBe(binDir)
    const otherBin = await installations.forRemote('owner/b')
    expect(otherBin).not.toBe(binDir)
    const scoped = join(binDir, 'holi')
    const descriptor = join(dirname(binDir), 'cli-endpoint.json')
    const original = await readFile(descriptor, 'utf8')
    const run = async (bin: string, cwd: string, args: string[]) => {
      try {
        return { code: 0, ...(await exec(bin, args, { cwd, env: { PATH: process.env.PATH } })) }
      } catch (error) {
        const e = error as { code: number; stdout: string; stderr: string }
        return e
      }
    }
    const foreign = await run(scoped, dir, ['probe', 'read', '--vault=owner/b'])
    expect(foreign.code, `unauthorized dispatch: ${foreign.stdout}`).not.toBe(0)
    expect(calls).not.toContain('owner/b')
    for (const cwd of [roots.get('owner/b')!, dir]) {
      expect(await run(scoped, cwd, ['probe', 'read'])).toMatchObject({
        code: 0,
        stdout: 'Owner/Notes\n',
      })
    }
    expect(
      await run(human, roots.get('Owner/Notes')!, ['probe', 'read', '--vault=owner/b']),
    ).toMatchObject({ code: 0, stdout: 'owner/b\n' })
    expect(await run(join(otherBin, 'holi'), dir, ['probe', 'read'])).toMatchObject({
      code: 0,
      stdout: 'owner/b\n',
    })
    expect((await exec(join(binDir, 'fallback/node'), ['-p', '21 * 2'])).stdout.trim()).toBe('42')
    for (const contents of [
      '',
      '{bad json',
      JSON.stringify({ host: '127.0.0.1', port: server.port(), token: 'f'.repeat(32) }, null, 2) +
        '\n',
      JSON.stringify({ host: '127.0.0.1', port: server.port(), token: machine.token }, null, 2) +
        '\n',
    ]) {
      await writeFile(descriptor, contents)
      const before = calls.length
      expect((await run(scoped, dir, ['probe', 'read', '--vault=owner/b'])).code).not.toBe(0)
      expect(calls.length).toBe(before)
    }
    await rm(descriptor)
    expect((await run(scoped, dir, ['probe', 'read'])).code).not.toBe(0)
    await symlink(join(dir, 'cli-endpoint.json'), descriptor)
    expect((await run(scoped, dir, ['probe', 'read'])).code).not.toBe(0)
    await rm(descriptor)
    await writeFile(descriptor, original, { mode: 0o600 })
    if (process.platform !== 'win32') {
      await chmod(descriptor, 0o644)
      expect((await run(scoped, dir, ['probe', 'read'])).code).not.toBe(0)
      await chmod(descriptor, 0o600)
    }
    // A recording curl adapter faithfully delegates HTTP to the installed curl.
    // Only argv and config file metadata are retained, never credentials.
    const curl = (await exec('which', ['curl'])).stdout.trim()
    const tools = join(dir, 'tools'),
      scratch = join(dir, 'scratch'),
      evidence = join(dir, 'curl-argv')
    await mkdir(tools)
    await mkdir(scratch)
    await writeFile(
      join(tools, 'curl'),
      `#!/bin/sh
printf '%s\\n' "$@" > '${evidence}'
previous=''
for arg in "$@"; do
  if [ "$previous" = --config ]; then ls -ln "$arg" > '${evidence}.mode'; fi
  previous=$arg
done
exec '${curl}' "$@"
`,
      { mode: 0o755 },
    )
    const secured = await exec(scoped, ['probe', 'read'], {
      cwd: dir,
      env: { PATH: `${tools}:${process.env.PATH}`, TMPDIR: scratch },
    })
    expect(secured.stdout).toBe('Owner/Notes\n')
    const argv = await readFile(evidence, 'utf8')
    expect(argv).not.toContain(server.tokenForVault('Owner/Notes'))
    expect(argv).not.toContain(machine.token)
    expect(argv).not.toContain('?t=')
    expect(argv).toContain('--config')
    if (process.platform !== 'win32')
      expect(await readFile(`${evidence}.mode`, 'utf8')).toMatch(/^-rw-------/)
    expect(await readdir(scratch)).toEqual([])
    const token = server.tokenForVault('Owner/Notes')
    for (const [path, header] of [
      ['/cli?t=' + token, token],
      ['/hook', token],
      ['/cli', 'bad'],
      ['/cli', token + ', ' + token],
    ]) {
      const response = await fetch(`http://127.0.0.1:${server.port()}${path}`, {
        method: 'POST',
        headers: { 'x-holi-cli-token': header },
        body: 'argv=probe&argv=read',
      })
      expect(response.status).toBe(403)
    }
    server.route('/hook', { body: 'discard', handle: (remote) => ({ status: 200, body: remote }) })
    expect(
      await (
        await fetch(`http://127.0.0.1:${server.port()}/hook?t=${token}`, { method: 'POST' })
      ).text(),
    ).toBe('Owner/Notes')
    await installations.dispose()
    await expect(lstat(descriptor)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await run(scoped, dir, ['probe', 'read'])).code).not.toBe(0)
    await expect(installations.forRemote('owner/notes')).rejects.toThrow()
  } finally {
    await installations.dispose()
    await machine?.dispose()
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)

it('installs distinct usable CLIs for remotes with reserved or trailing-dot segments', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'holi-vault-cli-names-')))
  const capabilities = createCapabilityRegistry()
  const remotes = ['owner/con', 'owner/con.', 'owner/prn.', 'aux/Notes']
  const roots = new Map<string, string>()
  const host = createCapabilityHost({
    registry: capabilities,
    rootFor: async (remote) => roots.get(remote) ?? null,
    get: () => null,
    core: noCoreServices,
    pluginEnabled: async () => true,
    claims: async () => [],
  })
  const server = createBridgeServer({
    log: () => {},
    cli: {
      dispatch: host.dispatch,
      commands: (remote) => capabilities.commands(remote),
      rootFor: async (remote) => roots.get(remote) ?? null,
    },
  })
  const installations = createVaultCliInstallations(dir, server, process.execPath)
  try {
    for (const [index, remote] of remotes.entries()) {
      const root = join(dir, `root-${index}`)
      await mkdir(root)
      roots.set(remote, root)
      capabilities.register(
        ['probe'],
        {
          'probe.read': cap({
            doors: ['cli'],
            cli: { args: [], summary: 'report vault' },
            params: () => null,
            run: async (ctx) => ctx.remote,
            text: (value) => value,
          }),
        },
        'probe',
        remote,
      )
    }
    await server.start()
    const bins = new Set<string>()
    for (const remote of remotes) {
      const bin = await installations.forRemote(remote)
      bins.add(bin)
      expect(
        (
          await exec(join(bin, 'holi'), ['probe', 'read'], {
            cwd: dir,
            env: { PATH: process.env.PATH },
          })
        ).stdout,
      ).toBe(`${remote}\n`)
    }
    expect(bins.size).toBe(remotes.length)
  } finally {
    await installations.dispose()
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
