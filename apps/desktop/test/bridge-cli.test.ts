/**
 * `holi`, for real: the generated script run against a live bridge, with
 * every command's real `cli` spec and a recording fake behind each one.
 *
 * Generated shell is the one thing in this codebase no other test would cover:
 * a quoting bug in it does not fail loudly, it sends a different argument.
 */
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, sep, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentCapabilities } from '../src/plugins/agent/main/host/capabilities'
import { appsCapabilities, storeCapabilities } from '../src/plugins/apps/main/capabilities'
import { installHoliCli } from '../src/main/bridge/cli'
import { createBridgeServer, type BridgeServer } from '../src/main/bridge/server'
import { SPILL_BYTES } from '../src/main/bridge/spill'
import { CapabilityError, NEXT_STEP } from '../src/main/capabilities/error'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import {
  cap,
  createCapabilityRegistry,
  type AnyCapability,
} from '../src/main/capabilities/registry'
import { noCoreServices } from '../src/main/capabilities/services'
import { vaultCapabilities } from '../src/main/capabilities/vault-caps'
import { pdfCapabilities } from '../src/plugins/pdf/main/capabilities'
import { taskCapabilities } from '../src/plugins/tasks/main/capabilities'
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
    ...vaultCapabilities({
      updateSkills: async () => ({ summary: '', conflicts: null }),
      pendingSkills: async () => [],
      open: () => {},
      screenshot: async () => new Uint8Array(),
    }),
    ...appsCapabilities({
      events: { emit: () => {} },
      appDoor: () => {
        throw new Error('no app door here')
      },
      grants: { status: async () => ({ codeHash: '', affordances: [] }), grant: async () => true },
    }),
    ...storeCapabilities(),
    ...taskCapabilities({ today: () => '2026-09-30' }),
    ...pdfCapabilities({
      signatures: { read: async () => '[]', write: async () => {} },
      typst: async () => null,
      diagrams: async () => [],
    }),
    ...agentCapabilities({
      sessions: {} as never,
      terminals: {} as never,
      liveRemote: () => null,
      commitNow: async () => null,
    }),
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
        claims: async () => [],
      }).dispatch,
      commands: () => registry.commands(),
      rootFor: async () => dir,
      machine: {
        token: () => 'a'.repeat(64),
        resolveTarget: async (selector, cwd) => {
          if (selector !== null)
            return selector.toLowerCase() === 'owner/repo'
              ? { remote: 'owner/repo', root: dir, live: true }
              : null
          if (cwd === null || !isAbsolute(cwd)) return null
          const rest = relative(await realpath(dir), cwd)
          return rest === '' || (!rest.startsWith(`..${sep}`) && rest !== '..')
            ? { remote: 'owner/repo', root: dir, live: true }
            : null
        },
      },
    },
  })
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'holi-cli-')))
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
  await writeEndpoint()
})

async function writeEndpoint(): Promise<void> {
  await writeFile(
    join(dir, 'cli-endpoint.json'),
    JSON.stringify({ host: '127.0.0.1', port: server.port(), token: 'a'.repeat(64) }, null, 2) +
      '\n',
    { mode: 0o600 },
  )
}

afterEach(async () => {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

describe('the installed script', () => {
  it('is executable', async () => {
    expect((await stat(bin)).mode & 0o777).toBe(0o755)
  })
})

describe('endpoint discovery', () => {
  it('fails clearly when the generated descriptor is absent', async () => {
    await rm(join(dir, 'cli-endpoint.json'))
    const res = await run(bin, ['sync', 'status'], env)
    expect(res.code).toBe(1)
    expect(res.stderr).toMatch(/Holi is not running/)
  })

  it('rejects malformed, duplicate, and incomplete descriptor fields', async () => {
    const valid = JSON.stringify(
      { host: '127.0.0.1', port: server.port(), token: 'a'.repeat(64) },
      null,
      2,
    )
    for (const contents of [
      valid.replace('127.0.0.1', 'localhost'),
      valid.replace(
        `"port": ${server.port()},`,
        `"port": ${server.port()},\n  "port": ${server.port()},`,
      ),
      valid.replace(/  "token":.*\n/, ''),
      valid.replace('"port":', '"port": 0,\n  "other":'),
    ]) {
      await writeFile(join(dir, 'cli-endpoint.json'), contents + '\n', { mode: 0o600 })
      const res = await run(bin, ['sync', 'status'], env)
      expect(res.code).toBe(1)
      expect(res.stderr).toMatch(/descriptor is malformed/)
    }
  })

  it('rejects a symlink instead of following it', async () => {
    await rm(join(dir, 'cli-endpoint.json'))
    await writeFile(join(dir, 'elsewhere'), '{}')
    await import('node:fs/promises').then(({ symlink }) =>
      symlink(join(dir, 'elsewhere'), join(dir, 'cli-endpoint.json')),
    )
    const res = await run(bin, ['sync', 'status'], env)
    expect(res.code).toBe(1)
    expect(res.stderr).toMatch(/missing or unsafe/)
  })

  it('finds the managed target from physical cwd and refuses outside it', async () => {
    await mkdir(join(dir, 'Notes/deep'), { recursive: true })
    expect((await run(bin, ['sync', 'status'], env, '', join(dir, 'Notes/deep'))).code).toBe(0)
    expect((await run(bin, ['sync', 'status'], env, '', tmpdir())).code).toBe(2)
  })

  it('rejects a stale endpoint without falling back to vault-local credentials', async () => {
    await writeFile(
      join(dir, 'cli-endpoint.json'),
      JSON.stringify({ host: '127.0.0.1', port: 1, token: 'a'.repeat(64) }, null, 2),
      { mode: 0o600 },
    )
    const res = await run(bin, ['sync', 'status'], env)
    expect(res.code).toBe(1)
    expect(res.stderr).toMatch(/could not reach/)
  })

  it('quotes a trusted descriptor path containing spaces and apostrophes', async () => {
    const special = join(dir, "user data's folder")
    await mkdir(special)
    const specialBin = await installHoliCli(special)
    await writeFile(
      join(special, 'cli-endpoint.json'),
      JSON.stringify({ host: '127.0.0.1', port: server.port(), token: 'a'.repeat(64) }, null, 2) +
        '\n',
      { mode: 0o600 },
    )
    const res = await run(specialBin, ['sync', 'status'], env)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('sync.status ok\n')
  })

  it('keeps credentials out of curl argv and removes private request files', async () => {
    const shim = join(dir, 'curl-shim')
    await mkdir(shim)
    const log = join(dir, 'curl-argv')
    const curl = execFileSync('which', ['curl'], { encoding: 'utf8' }).trim()
    await writeFile(
      join(shim, 'curl'),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> "$CLI_ARG_LOG"\nexec '${curl}' "$@"\n`,
      { mode: 0o755 },
    )
    const res = await run(bin, ['sync', 'status'], {
      ...env,
      PATH: `${shim}:${env.PATH}`,
      CLI_ARG_LOG: log,
    })
    expect(res.code).toBe(0)
    const args = (await readFile(log, 'utf8')).split('\n').filter(Boolean)
    expect(args.join(' ')).not.toContain('a'.repeat(64))
    for (const option of ['--config', '-o']) {
      const path = args[args.indexOf(option) + 1]!
      await expect(readFile(path)).rejects.toThrow()
    }
  })

  it('rejects an authentication failure without printing the token', async () => {
    await writeFile(
      join(dir, 'cli-endpoint.json'),
      JSON.stringify({ host: '127.0.0.1', port: server.port(), token: 'b'.repeat(64) }, null, 2),
      { mode: 0o600 },
    )
    const res = await run(bin, ['sync', 'status'], env)
    expect(res.code).toBe(1)
    expect(res.stderr).toMatch(/rejected the request/)
    expect(res.stderr).not.toContain('b'.repeat(64))
  })

  it('does not expose the credential in the generated script', async () => {
    const script = await readFile(bin, 'utf8')
    expect(script).not.toContain('a'.repeat(64))
    expect(script).toContain('cli-endpoint.json')
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

  it('preserves Unicode arguments and the option terminator', async () => {
    const res = await run(bin, ['apps', 'open', '--', 'føø/日本語.md'], env)
    expect(res.code).toBe(0)
    expect(capability).toHaveBeenCalledWith('apps.open', { path: 'føø/日本語.md' })
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

  it('names a refusal code and the next step, the thrower one when it gave one', async () => {
    capability.mockRejectedValueOnce(new CapabilityError('UNAUTHORIZED', 'expired', 'reconnect X'))
    const own = await run(bin, ['store', 'get', 'T.app', 'items', 'a'], env)
    expect(own.code).toBe(1)
    expect(own.stderr).toBe('holi store get: UNAUTHORIZED: expired\nnext: reconnect X\n')

    capability.mockRejectedValueOnce(new CapabilityError('BAD_REQUEST', 'bad id'))
    const generic = await run(bin, ['store', 'get', 'T.app', 'items', 'a'], env)
    expect(generic.stderr).toBe(
      `holi store get: BAD_REQUEST: bad id\nnext: ${NEXT_STEP.BAD_REQUEST}\n` +
        'usage: holi store get <bundle> <collection> <id>\n',
    )
  })
})

describe('large machine responses', () => {
  it('spills large responses and keeps JSON notices parseable', async () => {
    const text = JSON.stringify(
      Array.from({ length: 400 }, (_, i) => ({ id: `t${i}`, subject: 'x'.repeat(40) })),
    )
    capability.mockResolvedValueOnce({ text })
    const plain = await run(bin, ['store', 'list', 'T.app', 'items'], env)
    expect(plain.code).toBe(0)
    const plainPath = plain.stdout.split('\n')[1]!.trim()
    expect(isAbsolute(plainPath)).toBe(false)
    expect(await readFile(join(dir, plainPath), 'utf8')).toBe(text)

    capability.mockResolvedValueOnce({ text })
    const json = await run(bin, ['store', 'list', 'T.app', 'items', '--json'], env)
    expect(json.code).toBe(0)
    const notice = JSON.parse(json.stdout) as { spilled: string; bytes: number }
    expect(notice.bytes).toBeGreaterThan(SPILL_BYTES)
    expect(await readFile(join(dir, notice.spilled), 'utf8')).toBe(
      JSON.stringify({ text }, null, 2),
    )
  })
})

describe('a pending docs mutation receipt', () => {
  const result =
    vi.fn<(params: Record<string, string>) => { path: string; revision: string; pushed: boolean }>()
  let pushed = false
  const mutation = cap({
    doors: ['cli'],
    writes: true,
    cli: { args: ['path'], summary: 'create note from stdin', stdin: 'body' },
    cliSucceeded: (value) =>
      typeof value === 'object' && value !== null && 'pushed' in value && value.pushed === true,
    params: (raw) => raw as Record<string, string>,
    run: async (_ctx, params) => {
      result(params)
      return { path: params.path!, revision: 'a'.repeat(64), pushed }
    },
  })

  beforeEach(async () => {
    await server.stop()
    result.mockClear()
    pushed = false
    server = bridge({ 'docs.create': mutation }, ['docs'])
    await server.start()
    await writeEndpoint()
  })

  it('exits 1 with the JSON receipt on stderr and writes stdin only once', async () => {
    const res = await run(bin, ['docs', 'create', 'draft.md'], env, '# Draft\n')
    expect(res.code).toBe(1)
    expect(res.stdout).toBe('')
    expect(JSON.parse(res.stderr)).toEqual({
      path: 'draft.md',
      revision: 'a'.repeat(64),
      pushed: false,
    })
    expect(result).toHaveBeenCalledTimes(1)
    expect(result).toHaveBeenCalledWith({ path: 'draft.md', body: '# Draft\n' })
  })

  it('exits 0 when the receipt confirms the push', async () => {
    pushed = true
    const res = await run(bin, ['docs', 'create', 'draft.md'], env, '# Draft\n')
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('"pushed": true')
    expect(result).toHaveBeenCalledTimes(1)
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
    await writeEndpoint()
  })

  it('runs once, with stdin, preserving paths with spaces', async () => {
    const res = await run(bin, ['x', 'echo', 'My notes/a b.md'], env, 'hello\nthere\n')
    expect(res).toMatchObject({ code: 0, stdout: 'hello\nthere\n\n' })
    // The first leg ran nothing: a write never runs without its body.
    expect(ran).toHaveBeenCalledTimes(1)
    expect(ran).toHaveBeenCalledWith({ to: 'My notes/a b.md', body: 'hello\nthere\n' })
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
