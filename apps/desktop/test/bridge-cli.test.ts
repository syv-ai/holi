/**
 * `holi`, for real: the generated script run against a live bridge, with
 * every command's real `cli` spec and a recording fake behind each one.
 *
 * Generated shell is the one thing in this codebase no other test would cover:
 * a quoting bug in it does not fail loudly, it sends a different argument.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentCapabilities } from '../src/main/agent/capabilities'
import { appCapabilities } from '../src/main/apps/capabilities'
import { installHoliCli } from '../src/main/bridge/cli'
import { createBridgeServer, type BridgeServer } from '../src/main/bridge/server'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import {
  cap,
  createCapabilityRegistry,
  type AnyCapability,
} from '../src/main/capabilities/registry'
import { noCoreServices } from '../src/main/capabilities/services'
import { vaultCapabilities } from '../src/main/capabilities/vault-caps'
import { pdfCapabilities } from '../src/plugins/pdf/main/capabilities'
import { taskCapabilities } from '../src/main/vault/task-capabilities'
import { bridgeLines, writeVaultEnv } from './helpers/bridge-env'

const execFileAsync = promisify(execFile)

async function run(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  /** What the script reads on stdin. Always passed, even empty: a pipe nobody
   *  closes is a script that never returns. */
  input = '',
  /** Where it runs: inside the test's vault, unless said otherwise. */
  cwd = dir,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const child = execFileAsync(bin, args, { env, cwd })
    child.child.stdin?.end(input)
    const { stdout, stderr } = await child
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

type Called = (name: string, params: Record<string, string>) => Promise<{ text: string }>

/** Every real command, its run swapped for `called`. */
function recording(called: Called): Record<string, AnyCapability> {
  const real: Record<string, AnyCapability> = {
    ...vaultCapabilities({ updateSkills: async () => '' }),
    ...appCapabilities({ events: { emit: () => {} } }),
    ...taskCapabilities({ today: () => '2026-09-30' }),
    ...pdfCapabilities({
      signatures: { read: async () => '[]', write: async () => {} },
      typst: async () => null,
    }),
    ...agentCapabilities({ sessionsFor: () => [] }),
  }
  return Object.fromEntries(
    Object.entries(real).map(([name, entry]) => [
      name,
      {
        ...entry,
        params: (raw: unknown) => raw,
        run: (_ctx, p) => called(name, p),
        text: (r: { text: string }) => r.text,
      },
    ]),
  )
}

let dir: string
let bin: string
let server: BridgeServer
let env: NodeJS.ProcessEnv
let capability: ReturnType<typeof vi.fn<Called>>

function bridge(table: Record<string, AnyCapability>, namespaces: string[]): BridgeServer {
  const registry = createCapabilityRegistry()
  registry.register(namespaces, table)
  return createBridgeServer({
    log: () => {},
    cli: {
      dispatch: createCapabilityHost({
        registry,
        rootFor: async () => dir,
        active: () => null,
        core: noCoreServices,
        pluginEnabled: async () => true,
      }).dispatch,
      commands: () => registry.commands(),
    },
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-cli-'))
  bin = await installHoliCli(dir)
  capability = vi.fn<Called>((name, params) =>
    params.id === 'gone'
      ? Promise.reject(new Error('no such record'))
      : Promise.resolve({ name, params, text: `${name} ok` }),
  )
  const table = recording(capability)
  server = bridge(table, [...new Set(Object.keys(table).map((n) => n.split('.')[0]!))])
  await server.start()
  env = { PATH: process.env.PATH ?? '' }
  await writeVaultEnv(dir, bridgeLines(server.port()!, server.tokenForVault('owner/repo')))
})

afterEach(async () => {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

describe('the installed script', () => {
  it('is executable', async () => {
    expect((await stat(bin)).mode & 0o777).toBe(0o755)
  })
})

describe('when Holi is not running', () => {
  it('exits non-zero with a sentence a human can read', async () => {
    await writeVaultEnv(dir, null)
    const res = await run(bin, ['apps', 'open', 'retro'], env)
    expect(res.code).toBe(1)
    expect(res.stderr).toMatch(/holi: Holi is not running/)
  })

  it('finds the vault from a folder inside it, and nothing outside one', async () => {
    await mkdir(join(dir, 'Notes/deep'), { recursive: true })
    expect((await run(bin, ['sync', 'status'], env, '', join(dir, 'Notes/deep'))).code).toBe(0)
    expect((await run(bin, ['sync', 'status'], env, '', tmpdir())).code).toBe(1)
  })

  it('reads the file, never runs it', async () => {
    // A collaborator could force-add one: a line that would run as shell must
    // not, and a value that is not digits or hex is no value at all.
    await writeVaultEnv(
      dir,
      `HOLI_BRIDGE_PORT=${server.port()}\nHOLI_BRIDGE_TOKEN=$(touch ${dir}/ran)\ntouch ${dir}/ran\n`,
    )
    const res = await run(bin, ['sync', 'status'], env)
    expect(res.code).toBe(1)
    await expect(stat(join(dir, 'ran'))).rejects.toThrow()
  })
})

describe('usage', () => {
  it('names every command with its summary when called with none', async () => {
    const res = await run(bin, [], env)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('holi apps open <path>')
    expect(res.stderr).toContain('holi store put <bundle> <collection> <value> [<id>]')
    expect(res.stderr).toContain('holi skills update')
    expect(res.stderr).toContain("a vault PDF's comments")
  })

  it('refuses an unknown command rather than doing something adjacent', async () => {
    const res = await run(bin, ['apps', 'delete', 'retro'], env)
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('no such command: apps delete')
    expect(capability).not.toHaveBeenCalled()
  })

  it('refuses anything before the verb', async () => {
    for (const args of [['--json', 'sync', 'status'], ['sync', '--json', 'status'], ['sync']]) {
      expect((await run(bin, args, env)).code, args.join(' ')).toBe(2)
    }
    expect(capability).not.toHaveBeenCalled()
  })

  it('needs every required argument, and no more', async () => {
    for (const args of [
      ['apps', 'open'],
      ['store', 'list', 'T.app'],
      ['store', 'get', 'T.app', 'items'],
      ['store', 'check'],
      ['vault', 'members', 'all'],
      ['pdf', 'comments', '--all', 'a.pdf'],
    ]) {
      const res = await run(bin, args, env)
      expect(res.code, args.join(' ')).toBe(2)
    }
    expect(capability).not.toHaveBeenCalled()
  })
})

describe('a command', () => {
  it('passes a path through verbatim, spaces and all', async () => {
    // The CLI must not be the thing that mangles it, or the refusal names an
    // argument the user never typed.
    const res = await run(bin, ['apps', 'open', 'My Apps/my app'], env)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('apps.open ok\n')
    expect(capability).toHaveBeenCalledWith('apps.open', { path: 'My Apps/my app' })
  })

  it('prints JSON with --json, before or after the path', async () => {
    for (const args of [
      ['--json', 'a.pdf'],
      ['a.pdf', '--json'],
    ]) {
      const res = await run(bin, ['pdf', 'comments', ...args], env)
      expect(res.code).toBe(0)
      expect(JSON.parse(res.stdout)).toMatchObject({
        name: 'pdf.comments',
        params: { path: 'a.pdf' },
      })
    }
  })

  it('takes any param as --name value', async () => {
    await run(bin, ['store', 'list', '--collection', 'items', 'T.app'], env)
    expect(capability).toHaveBeenLastCalledWith('store.list', {
      bundle: 'T.app',
      collection: 'items',
    })
  })

  it('puts a value verbatim, with or without an id', async () => {
    const value = '{"title": "a b & c=d"}'
    await run(bin, ['store', 'put', 'My Apps/T.app', 'items', value], env)
    expect(capability).toHaveBeenLastCalledWith('store.put', {
      bundle: 'My Apps/T.app',
      collection: 'items',
      value,
    })
    await run(bin, ['store', 'put', 'T.app', 'items', value, '2026-09-30'], env)
    expect(capability).toHaveBeenLastCalledWith('store.put', {
      bundle: 'T.app',
      collection: 'items',
      id: '2026-09-30',
      value,
    })
  })

  it('maps each spelling to its capability', async () => {
    for (const [args, name] of [
      [['sync', 'status'], 'sync.status'],
      [['agent', 'sessions'], 'agent.sessions'],
      [['vault', 'members'], 'vault.members'],
      [['vault', 'recents'], 'vault.recents'],
      [['skills', 'update'], 'skills.update'],
      [['apps', 'init', 'retro-board'], 'apps.init'],
      [['tasks', 'complete', 'task.rent.md'], 'tasks.complete'],
      [['docs', 'render', 'My notes/a b.md'], 'docs.render'],
      [['store', 'check', 'T.app/data/items/x.json'], 'store.check'],
    ] as const) {
      const res = await run(bin, [...args], env)
      expect(res.code, args.join(' ')).toBe(0)
      expect(res.stdout).toBe(`${name} ok\n`)
    }
  })

  it('puts a refusal on stderr after the command, and exits 1', async () => {
    const res = await run(bin, ['store', 'delete', 'T.app', 'items', 'gone'], env)
    expect(res.code).toBe(1)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('holi store delete: no such record\n')
  })
})

describe('a command that reads stdin', () => {
  const ran = vi.fn<(params: unknown) => void>()
  const echo = cap({
    doors: ['cli'],
    writes: true,
    cli: { args: ['to'], summary: 'echo a body', stdin: 'body', stdinUnless: 'draft' },
    params: (raw) => raw as Record<string, string>,
    run: async (_ctx, p) => {
      ran(p)
      return p.body ?? ''
    },
    text: (body) => body,
  })

  beforeEach(async () => {
    await server.stop()
    ran.mockClear()
    server = bridge({ 'x.echo': echo }, ['x'])
    await server.start()
    await writeVaultEnv(dir, bridgeLines(server.port()!, server.tokenForVault('owner/repo')))
  })

  it('runs once, with stdin, when the body is not an argument', async () => {
    const res = await run(bin, ['x', 'echo', 'ada'], env, 'hello\nthere\n')
    expect(res).toMatchObject({ code: 0, stdout: 'hello\nthere\n\n' })
    // The first leg ran nothing: a write never runs without its body.
    expect(ran).toHaveBeenCalledTimes(1)
    expect(ran).toHaveBeenCalledWith({ to: 'ada', body: 'hello\nthere\n' })
  })

  it('never reads stdin when the body is given', async () => {
    const res = await run(bin, ['x', 'echo', 'ada', '--body', 'hi'], env, 'ignored')
    expect(res).toMatchObject({ code: 0, stdout: 'hi\n' })
    expect(ran).toHaveBeenCalledWith({ to: 'ada', body: 'hi' })
  })

  it('never asks for stdin when the param that means "no body" is given', async () => {
    const res = await run(bin, ['x', 'echo', 'ada', '--draft', 'd1'], env, 'ignored')
    expect(res.code).toBe(0)
    expect(ran).toHaveBeenCalledWith({ to: 'ada', draft: 'd1' })
  })
})
