import { request } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBridgeServer, type BridgeServer } from '../src/main/bridge/server'
import type { Dispatch } from '../src/main/capabilities/dispatch'
import type { CliCommand } from '../src/main/capabilities/registry'

const READ: CliCommand = { name: 'docs.read', cli: { args: ['path'], summary: 'read' } }
const PLUGIN_READ: CliCommand = {
  name: 'google.read',
  cli: { args: ['threadId'], summary: 'plugin read', values: ['query'] },
}
const CHANGE: CliCommand = {
  name: 'store.put',
  cli: { args: [], stdin: 'content', summary: 'put' },
}
const servers: BridgeServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

function send(
  port: number,
  token: string,
  body: string,
  path = '/cli',
  extraHeaders: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'x-holi-cli-token': token, ...extraHeaders },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}
const argv = (...args: string[]) => new URLSearchParams(args.map((arg) => ['argv', arg])).toString()

async function rig(
  options: {
    live?: boolean
    dispatch?: Dispatch
    targetRoot?: () => string
    resolve?: (
      selector: string | null,
      cwd: string | null,
    ) => Promise<{ remote: string; root: string; live: boolean } | null>
    commands?: readonly CliCommand[]
    listVaults?: () => Promise<readonly { remote: string; name: string; live: boolean }[]>
  } = {},
) {
  const token = 'machine-secret'
  const root = options.targetRoot ?? (() => '/vault/one')
  const machine = {
    token: () => token,
    resolveTarget:
      options.resolve ??
      vi.fn(async () => ({ remote: 'owner/one', root: root(), live: options.live ?? false })),
    listVaults: options.listVaults ?? vi.fn(async () => []),
  }
  const dispatch =
    options.dispatch ?? vi.fn<Dispatch>(async () => ({ value: 'ok', text: 'ok', writes: false }))
  const server = createBridgeServer({
    cli: {
      machine,
      dispatch,
      commands: () => options.commands ?? [READ, PLUGIN_READ, CHANGE],
      rootFor: async () => null,
    },
    log: () => {},
  })
  servers.push(server)
  await server.start()
  return { server, port: server.port()!, token, dispatch, machine }
}

describe('machine CLI bridge', () => {
  it('lists managed vaults as text or JSON without resolving a target', async () => {
    const listVaults = vi.fn(async () => [{ remote: 'owner/one', name: 'One', live: false }])
    const r = await rig({ listVaults })
    expect(await send(r.port, r.token, argv('vault', 'list'))).toEqual({
      status: 200,
      body: 'owner/one\tOne\tclosed',
    })
    const json = await send(r.port, r.token, argv('vault', 'list', '--json'))
    expect(JSON.parse(json.body)).toEqual([{ remote: 'owner/one', name: 'One', live: false }])
    expect(listVaults).toHaveBeenCalledTimes(2)
  })

  it('rejects vault selection for list and legacy credential enumeration', async () => {
    const r = await rig()
    expect(
      (await send(r.port, r.token, argv('vault', 'list', '--vault', 'owner/one'))).status,
    ).toBe(422)
    const legacy = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: r.port,
          path: `/cli?t=${r.server.tokenForVault('owner/one')}`,
          method: 'POST',
          headers: { 'x-holi-cli-token': r.token },
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        },
      )
      req.on('error', reject)
      req.end(argv('vault', 'list'))
    })
    expect(legacy).toBe(403)
  })

  it('resolves targeted plugin help without requiring execution arguments', async () => {
    const r = await rig()
    const result = await send(
      r.port,
      r.token,
      argv('google', 'read', '--vault', 'owner/one', '--help'),
    )
    expect(result.status).toBe(200)
    expect(result.body).toContain('usage: holi google read <threadId>')
    expect(r.dispatch).not.toHaveBeenCalled()
  })

  it('discovers selectors after option values that look like --vault', async () => {
    for (const selector of [['--vault', 'owner/one'], ['--vault=owner/one']]) {
      const r = await rig({ live: true })
      const result = await send(
        r.port,
        r.token,
        argv('google', 'read', '--query', '--vault', ...selector),
      )
      expect(result.status).toBe(400)
      expect(result.body).toContain('threadId is missing')
    }
  })

  it('answers help before resolving an explicit vault target', async () => {
    const resolve = vi.fn(async () => null)
    const r = await rig({ resolve })
    const result = await send(
      r.port,
      r.token,
      argv('docs', 'read', '--vault', 'owner/missing', '--help'),
    )
    expect(result.status).toBe(200)
    expect(result.body).toContain('usage: holi docs read <path>')
    expect(resolve).not.toHaveBeenCalled()
    expect(r.dispatch).not.toHaveBeenCalled()
  })

  it('refuses a closed stdin command before asking for its body', async () => {
    const r = await rig()
    const result = await send(r.port, r.token, argv('store', 'put'))
    expect(result.status).toBe(422)
    expect(result.body).toContain('vault is closed')
  })

  it('allows closed core reads but refuses closed plugin reads', async () => {
    const dispatch = vi.fn<Dispatch>(async () => ({ value: 'read', text: 'read', writes: false }))
    const r = await rig({ dispatch })
    expect((await send(r.port, r.token, argv('docs', 'read', 'note.md'))).status).toBe(200)
    expect((await send(r.port, r.token, argv('links', 'read'))).status).toBe(422)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('rechecks target identity immediately before invocation and refuses changed roots or missing targets', async () => {
    for (const changed of [true, false]) {
      let resolveCount = 0
      const dispatch = vi.fn<Dispatch>(async (call) => {
        await call.beforeInvoke?.({ remote: call.remote, root: '/vault/one' })
        return { value: 'ran', text: 'ran', writes: false }
      })
      const r = await rig({
        live: true,
        dispatch,
        resolve: async () =>
          ++resolveCount === 1
            ? { remote: 'owner/one', root: '/vault/one', live: true }
            : changed
              ? { remote: 'owner/one', root: '/vault/two', live: true }
              : null,
      })
      const result = await send(r.port, r.token, argv('docs', 'read', 'x'))
      expect(result.status).toBe(422)
      expect(result.body).toContain('target changed')
    }
  })

  it('spills large output only to the captured target, with an absolute notice for an explicit selector', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-machine-'))
    const dispatch = vi.fn<Dispatch>(async () => ({
      value: 'x'.repeat(20_000),
      text: 'x'.repeat(20_000),
      writes: false,
    }))
    const r = await rig({ live: true, targetRoot: () => directory, dispatch })
    try {
      const result = await send(r.port, r.token, argv('docs', 'read', 'x', '--vault', 'owner/one'))
      expect(result.status).toBe(200)
      const absolute = result.body.match(/\n  (.+)\n/)
      expect(absolute?.[1]).toMatch(
        new RegExp(`^${directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`),
      )
      expect(await readFile(absolute![1]!, 'utf8')).toBe('x'.repeat(20_000))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not spill if the target disappears after execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-machine-'))
    let resolves = 0
    const r = await rig({
      live: true,
      dispatch: vi.fn<Dispatch>(async () => ({
        value: 'x'.repeat(20_000),
        text: 'x'.repeat(20_000),
        writes: false,
      })),
      resolve: async () =>
        ++resolves === 1 ? { remote: 'owner/one', root: directory, live: true } : null,
    })
    try {
      const result = await send(r.port, r.token, argv('docs', 'read', 'x'))
      expect(result.body).toBe('x'.repeat(20_000))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('restricts the machine credential to the exact CLI route and header-only auth', async () => {
    const r = await rig()
    expect((await send(r.port, r.token, '', '/turn/start')).status).toBe(403)
    expect((await send(r.port, r.token, '', '/unknown')).status).toBe(403)
    const tokenInUrl = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: r.port, path: `/cli?t=${r.token}`, method: 'POST' },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(tokenInUrl).toBe(403)
  })
})
