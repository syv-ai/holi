/**
 * `holi`, for real: the generated script run against a live ops server.
 *
 * Generated shell is the one thing in this codebase no other test would cover —
 * a quoting bug in it does not fail loudly, it sends a different argument.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOLI_CLI_SCRIPT, installHoliCli } from '../src/main/agent/cli'
import { createBridgeServer, type BridgeServer } from '../src/main/bridge/server'

const execFileAsync = promisify(execFile)

async function run(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  /** What the script reads on stdin. Always passed, even empty: a pipe nobody
   *  closes is a script that never returns. */
  input = '',
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const child = execFileAsync(bin, args, { env })
    child.child.stdin?.end(input)
    const { stdout, stderr } = await child
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

let dir: string
let bin: string
let server: BridgeServer
let env: NodeJS.ProcessEnv
/** The capability door, faked: what each command reached, by name. */
let capability: ReturnType<
  typeof vi.fn<
    (name: string, params: Record<string, string>) => Promise<{ value: unknown; text: string }>
  >
>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-cli-'))
  bin = await installHoliCli(dir)
  capability = vi.fn((name: string, params: Record<string, string>) =>
    params.id === 'gone'
      ? Promise.reject(new Error('no such record'))
      : Promise.resolve({ value: { name, params }, text: `${name} ok` }),
  )
  server = createBridgeServer({
    log: () => {},
    dispatch: async ({ name, params }) => ({
      ...(await capability(name, params as Record<string, string>)),
      writes: false,
    }),
  })
  await server.start()
  env = {
    PATH: process.env.PATH ?? '',
    HOLI_HOOK_PORT: String(server.port()),
    HOLI_HOOK_TOKEN: server.tokenForVault('owner/repo'),
  }
})

afterEach(async () => {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

describe('the installed script', () => {
  it('is executable', async () => {
    expect((await stat(bin)).mode & 0o777).toBe(0o755)
  })

  it('re-reads the port and token from the environment at every invocation', () => {
    // The port is ephemeral and moves across restarts, so baking either in
    // would make the CLI work exactly until the app was restarted once.
    expect(HOLI_CLI_SCRIPT).toContain('$HOLI_HOOK_PORT')
    expect(HOLI_CLI_SCRIPT).toContain('$HOLI_HOOK_TOKEN')
  })
})

describe('when Holi is not running', () => {
  it('exits non-zero with a sentence a human can read', async () => {
    const res = await run(bin, ['app', 'open', 'retro'], { PATH: env.PATH })
    expect(res.code).not.toBe(0)
    expect(res.stderr).toMatch(/holi: Holi is not running/)
  })
})

describe('usage', () => {
  it('names every subcommand when called with none', async () => {
    const res = await run(bin, [], env)
    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain('app open')
    expect(res.stderr).toContain('app init')
    expect(res.stderr).toContain('skills update')
    expect(res.stderr).toContain('pdf comments')
    expect(res.stderr).toContain('store list')
  })

  it('refuses an unknown subcommand rather than doing something adjacent', async () => {
    const res = await run(bin, ['app', 'delete', 'retro'], env)
    expect(res.code).not.toBe(0)
    expect(capability).not.toHaveBeenCalled()
  })
})

describe('app open', () => {
  it('reaches apps.open and prints the answer', async () => {
    const res = await run(bin, ['app', 'open', 'Finance/Budget.app'], env)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('apps.open ok\n')
    expect(capability).toHaveBeenCalledWith('apps.open', { path: 'Finance/Budget.app' })
  })

  it('passes a path through verbatim, spaces and all', async () => {
    // The CLI must not be the thing that mangles it, or the refusal names an
    // argument the user never typed.
    await run(bin, ['app', 'open', 'My Apps/my app'], env)
    expect(capability).toHaveBeenCalledWith('apps.open', { path: 'My Apps/my app' })
  })

  it('needs a path', async () => {
    const res = await run(bin, ['app', 'open'], env)
    expect(res.code).not.toBe(0)
  })
})

describe('pdf comments', () => {
  const cap = () => capability

  it('reaches the registry and prints its text as is', async () => {
    cap().mockResolvedValueOnce({ value: {}, text: '[From docs/msa.pdf, 1 comment]\n\nPage 1' })
    const res = await run(bin, ['pdf', 'comments', 'docs/msa.pdf'], env)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('[From docs/msa.pdf, 1 comment]\n\nPage 1\n')
    expect(res.stderr).toBe('')
    expect(cap()).toHaveBeenCalledWith('pdf.comments', { path: 'docs/msa.pdf' })
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

  it('passes a path with a space through intact', async () => {
    await run(bin, ['pdf', 'comments', 'client docs/a b.pdf'], env)
    expect(cap()).toHaveBeenCalledWith('pdf.comments', { path: 'client docs/a b.pdf' })
  })

  it('puts a refusal on stderr and exits non-zero', async () => {
    cap().mockRejectedValueOnce(new Error('gone.pdf not found'))
    const res = await run(bin, ['pdf', 'comments', 'gone.pdf'], env)
    expect(res.code).toBe(1)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('holi pdf comments: gone.pdf not found\n')
  })

  it('needs a path, and refuses an unknown option', async () => {
    expect((await run(bin, ['pdf', 'comments'], env)).code).toBe(2)
    expect((await run(bin, ['pdf', 'comments', '--all', 'a.pdf'], env)).code).toBe(2)
    expect(cap()).not.toHaveBeenCalled()
  })
})

describe('app init', () => {
  it('reaches apps.init', async () => {
    const res = await run(bin, ['app', 'init', 'retro-board'], env)
    expect(res.code).toBe(0)
    expect(capability).toHaveBeenCalledWith('apps.init', { path: 'retro-board' })
  })
})

describe('skills update', () => {
  it('prints the summary Holi answers', async () => {
    capability.mockResolvedValueOnce({ value: 'Skills: 1 updated.', text: 'Skills: 1 updated.' })
    const res = await run(bin, ['skills', 'update'], env)
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe('Skills: 1 updated.')
    expect(capability).toHaveBeenCalledWith('skills.update', {})
  })

  it('fails with the reason when Holi refuses', async () => {
    capability.mockRejectedValueOnce(new Error('No vault is open.'))
    const res = await run(bin, ['skills', 'update'], env)
    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain('No vault is open.')
  })
})

describe('store', () => {
  const cap = () => capability

  it('lists a collection through the capability door', async () => {
    const res = await run(bin, ['store', 'list', 'Work/Tracker.app', 'items'], env)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('store.list ok\n')
    expect(cap()).toHaveBeenCalledWith('store.list', {
      bundle: 'Work/Tracker.app',
      collection: 'items',
    })
  })

  it('prints JSON with --json', async () => {
    const res = await run(bin, ['store', 'get', '--json', 'A.app', 'items', 'x'], env)
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout)).toMatchObject({ name: 'store.get' })
  })

  it('puts a value verbatim, with or without an id', async () => {
    const value = '{"title": "a b & c=d"}'
    await run(bin, ['store', 'put', 'My Apps/T.app', 'items', value], env)
    expect(cap()).toHaveBeenLastCalledWith('store.put', {
      bundle: 'My Apps/T.app',
      collection: 'items',
      value,
    })
    await run(bin, ['store', 'put', 'T.app', 'items', '2026-09-30', value], env)
    expect(cap()).toHaveBeenLastCalledWith('store.put', {
      bundle: 'T.app',
      collection: 'items',
      id: '2026-09-30',
      value,
    })
  })

  it('checks one data file', async () => {
    await run(bin, ['store', 'check', 'T.app/data/items/x.json'], env)
    expect(cap()).toHaveBeenLastCalledWith('store.check', { path: 'T.app/data/items/x.json' })
  })

  it('puts a refusal on stderr and exits non-zero', async () => {
    const res = await run(bin, ['store', 'delete', 'T.app', 'items', 'gone'], env)
    expect(res.code).toBe(1)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('holi store delete: no such record\n')
  })

  it('needs its arguments', async () => {
    for (const args of [
      ['list', 'T.app'],
      ['get', 'T.app', 'items'],
      ['put', 'T.app'],
      ['check'],
    ]) {
      const res = await run(bin, ['store', ...args], env)
      expect(res.code).toBe(2)
    }
    expect(cap()).not.toHaveBeenCalled()
  })
})

describe('reads through the capability door', () => {
  const cap = () => capability

  it('maps each command to its capability', async () => {
    for (const [args, name] of [
      [['sync', 'status'], 'sync.status'],
      [['sessions'], 'agent.sessions'],
      [['members'], 'vault.members'],
      [['recents'], 'vault.recents'],
    ] as const) {
      const res = await run(bin, [...args], env)
      expect(res.code, args.join(' ')).toBe(0)
      expect(res.stdout).toBe(`${name} ok\n`)
    }
  })

  it('asks for JSON with --json', async () => {
    const res = await run(bin, ['sync', 'status', '--json'], env)
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout)).toMatchObject({ name: 'sync.status' })
  })

  it('renders a note, path verbatim', async () => {
    await run(bin, ['docs', 'render', 'My notes/a b.md'], env)
    expect(cap()).toHaveBeenLastCalledWith('docs.render', { path: 'My notes/a b.md' })
  })

  it('completes a task through tasks.complete', async () => {
    const res = await run(bin, ['task', 'done', 'task.rent.md'], env)
    expect(res.code).toBe(0)
    expect(cap()).toHaveBeenLastCalledWith('tasks.complete', { path: 'task.rent.md' })
  })

  it('refuses a stray argument', async () => {
    const res = await run(bin, ['sessions', 'all'], env)
    expect(res.code).not.toBe(0)
    expect(cap()).not.toHaveBeenCalled()
  })
})
