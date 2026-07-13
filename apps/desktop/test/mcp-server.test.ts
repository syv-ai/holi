import { afterEach, describe, expect, it } from 'vitest'
import { McpServer } from '../src/main/agent/mcp-server'
import type { AgentOp } from '../src/main/agent/mcp-ops'

const TOKEN = 'test-token'

interface Rig {
  server: McpServer
  url: string
  preToolUse: Array<{ filePath?: string }>
  stops: number
  rpc(body: unknown, init?: { token?: string | null }): Promise<{ status: number; body: any }>
}

const servers: McpServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
})

function testOps(): AgentOp[] {
  return [
    {
      name: 'task_new',
      description: 'Create a task.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      run: async (args) => ({ id: 't1', title: args.title }),
    },
    {
      name: 'task_boom',
      description: 'Always fails.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        throw new Error('server said no')
      },
    },
  ]
}

async function rig(): Promise<Rig> {
  const preToolUse: Array<{ filePath?: string }> = []
  let stops = 0
  const server = new McpServer({
    token: TOKEN,
    ops: testOps(),
    onPreToolUse: (payload) => void preToolUse.push(payload),
    onStop: () => void (stops += 1),
  })
  servers.push(server)
  const port = await server.start()
  const url = `http://127.0.0.1:${port}`
  return {
    server,
    url,
    preToolUse,
    get stops() {
      return stops
    },
    async rpc(body, init = {}) {
      const token = init.token === undefined ? TOKEN : init.token
      const res = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : null }
    },
  }
}

describe('McpServer', () => {
  it('rejects every route without the bearer token', async () => {
    const r = await rig()
    const missing = await r.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: null })
    expect(missing.status).toBe(401)
    const wrong = await r.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: 'nope' })
    expect(wrong.status).toBe(401)
    const hook = await fetch(`${r.url}/hook/stop`, { method: 'POST' })
    expect(hook.status).toBe(401)
    expect(r.stops).toBe(0)
  })

  it('initialize echoes the client protocol version and advertises tools', async () => {
    const r = await rig()
    const res = await r.rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    })
    expect(res.status).toBe(200)
    expect(res.body.result.protocolVersion).toBe('2025-03-26')
    expect(res.body.result.capabilities.tools).toEqual({})
    expect(res.body.result.serverInfo.name).toBe('holi')
    expect(typeof res.body.result.instructions).toBe('string')
  })

  it('initialize falls back to the default protocol version', async () => {
    const r = await rig()
    const res = await r.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(res.body.result.protocolVersion).toBe('2025-06-18')
  })

  it('a notification (no id) gets 202 with an empty body', async () => {
    const r = await rig()
    const res = await r.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(res.status).toBe(202)
    expect(res.body).toBeNull()
  })

  it('ping returns an empty result', async () => {
    const r = await rig()
    const res = await r.rpc({ jsonrpc: '2.0', id: 2, method: 'ping' })
    expect(res.body).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
  })

  it('tools/list returns the ops with their schemas', async () => {
    const r = await rig()
    const res = await r.rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect(res.body.result.tools).toEqual([
      {
        name: 'task_new',
        description: 'Create a task.',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      },
      {
        name: 'task_boom',
        description: 'Always fails.',
        inputSchema: { type: 'object', properties: {} },
      },
    ])
  })

  it('tools/call runs the op and returns its result as JSON text content', async () => {
    const r = await rig()
    const res = await r.rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'task_new', arguments: { title: 'Ship it' } },
    })
    expect(res.body.result.isError).toBeUndefined()
    expect(res.body.result.content).toEqual([
      { type: 'text', text: JSON.stringify({ id: 't1', title: 'Ship it' }) },
    ])
  })

  it('an op failure is an in-band isError result, not a JSON-RPC error', async () => {
    const r = await rig()
    const res = await r.rpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'task_boom', arguments: {} },
    })
    expect(res.status).toBe(200)
    expect(res.body.error).toBeUndefined()
    expect(res.body.result.isError).toBe(true)
    expect(res.body.result.content[0].text).toContain('server said no')
  })

  it('an unknown tool is -32602 and an unknown method is -32601', async () => {
    const r = await rig()
    const tool = await r.rpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    })
    expect(tool.body.error.code).toBe(-32602)
    const method = await r.rpc({ jsonrpc: '2.0', id: 7, method: 'resources/list' })
    expect(method.body.error.code).toBe(-32601)
  })

  it('GET /mcp is 405 (POST-only streamable HTTP)', async () => {
    const r = await rig()
    const res = await fetch(`${r.url}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(405)
  })

  it('hook routes fire their callbacks and answer 204', async () => {
    const r = await rig()
    const pre = await fetch(`${r.url}/hook/pre-tool-use`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: '/work/notes/a.md' }),
    })
    expect(pre.status).toBe(204)
    expect(r.preToolUse).toEqual([{ filePath: '/work/notes/a.md' }])

    const stop = await fetch(`${r.url}/hook/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(stop.status).toBe(204)
    expect(r.stops).toBe(1)
  })

  it('mcpConfig() is the exact blob the CLI expects', async () => {
    const r = await rig()
    const port = new URL(r.url).port
    expect(r.server.endpoint()).toBe(`http://127.0.0.1:${port}`)
    expect(r.server.mcpConfig()).toEqual({
      mcpServers: {
        holi: {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: `Bearer ${TOKEN}` },
          alwaysLoad: true,
        },
      },
    })
  })
})
