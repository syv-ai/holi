/**
 * Localhost MCP endpoint for the agent session (spec §McpServer).
 *
 * Hand-rolled streamable-HTTP JSON-RPC on node:http (plan decision 2): 7 tools
 * and 2 hook routes don't justify a protocol SDK, and the repo already
 * hand-rolls its SSE. POST-only `/mcp` with plain JSON responses — the CLI
 * accepts a JSON body when we don't advertise a stream.
 *
 * Bound to 127.0.0.1 on an ephemeral port with a per-run bearer token that
 * only ever reaches the CLI (via the --mcp-config blob) and the hook scripts
 * (via the PTY env). Every route checks it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AgentOp } from './mcp-ops'

const DEFAULT_PROTOCOL_VERSION = '2025-06-18'
const MAX_BODY_BYTES = 4 * 1024 * 1024

const INSTRUCTIONS =
  'Holi vault ops. Tasks are files: tasks/<slug>-<id>.md, created/edited/deleted with the native file tools. ' +
  'These three tools are only for what a file write cannot express — task_set (complete a task: a file cannot say ' +
  'whether a recurring task should roll forward or end), task_list (query tasks; never glob the tasks/ folder), and ' +
  'note_rename (it rewrites [[links]]; never use mv). Notes and folders are named by vault-relative path, never by id.'

export interface McpServerDeps {
  token: string
  ops: AgentOp[]
  onPreToolUse(payload: { filePath?: string }): void
  onStop(): void
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number
  method?: string
  params?: Record<string, unknown>
}

export class McpServer {
  private server: Server | null = null
  private port = 0

  constructor(private readonly deps: McpServerDeps) {}

  async start(): Promise<number> {
    const server = createServer((req, res) => void this.handle(req, res).catch(() => this.fail(res)))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('MCP server failed to bind')
    this.port = address.port
    return this.port
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    server.closeAllConnections() // the CLI keeps the connection alive
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  endpoint(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /** The `--mcp-config` blob. Strictness is a CLI flag, not a key here. */
  mcpConfig(): Record<string, unknown> {
    return {
      mcpServers: {
        holi: {
          type: 'http',
          url: `${this.endpoint()}/mcp`,
          headers: { Authorization: `Bearer ${this.deps.token}` },
          // avoids the deferred-tool race on the session's first tool call
          alwaysLoad: true,
        },
      },
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.deps.token}`) {
      res.writeHead(401).end()
      return
    }
    const path = (req.url ?? '').split('?')[0]
    if (path === '/mcp') {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      await this.handleRpc(req, res)
      return
    }
    if (req.method === 'POST' && path === '/hook/pre-tool-use') {
      const body = await readJson(req).catch(() => ({}))
      const filePath = (body as { filePath?: unknown }).filePath
      this.deps.onPreToolUse(typeof filePath === 'string' ? { filePath } : {})
      res.writeHead(204).end()
      return
    }
    if (req.method === 'POST' && path === '/hook/stop') {
      this.deps.onStop()
      res.writeHead(204).end()
      return
    }
    res.writeHead(404).end()
  }

  private async handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let message: JsonRpcMessage
    try {
      message = (await readJson(req)) as JsonRpcMessage
    } catch {
      this.send(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      return
    }
    // notifications carry no id and expect no body
    if (message.id === undefined || message.id === null) {
      res.writeHead(202).end()
      return
    }
    const id = message.id
    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion
        this.send(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: typeof requested === 'string' ? requested : DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'holi', title: 'Holi vault', version: '1.0.0' },
            instructions: INSTRUCTIONS,
          },
        })
        return
      }
      case 'ping':
        this.send(res, 200, { jsonrpc: '2.0', id, result: {} })
        return
      case 'tools/list':
        this.send(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            tools: this.deps.ops.map((op) => ({
              name: op.name,
              description: op.description,
              inputSchema: op.inputSchema,
            })),
          },
        })
        return
      case 'tools/call': {
        const name = message.params?.name
        const op = this.deps.ops.find((o) => o.name === name)
        if (!op) {
          this.send(res, 200, {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `unknown tool: ${String(name)}` },
          })
          return
        }
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>
        try {
          const result = await op.run(args)
          this.send(res, 200, {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
          })
        } catch (err) {
          // op failures are the agent's problem to fix, not protocol errors —
          // in-band so the model sees the message and can retry
          const text = err instanceof Error ? err.message : String(err)
          this.send(res, 200, {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text }], isError: true },
          })
        }
        return
      }
      default:
        this.send(res, 200, {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `unknown method: ${String(message.method)}` },
        })
    }
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  private fail(res: ServerResponse): void {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
