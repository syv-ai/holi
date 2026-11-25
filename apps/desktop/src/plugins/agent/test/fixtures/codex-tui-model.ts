import { createServer, type ServerResponse } from 'node:http'
import { gunzipSync } from 'node:zlib'

const maxBodyBytes = 1024 * 1024
const maxEvents = 128
const promptArguments = {
  cmd: '/usr/bin/printf holi-528-fixture',
  login: false,
  sandbox_permissions: 'require_escalated',
  justification: 'Disposable native approval notification probe',
  max_output_tokens: 128,
}

export function startCodexTuiModel({ mode }: { mode: 'success' | 'approval' }) {
  const requests: Array<{ modelRequest: unknown }> = []
  let closed = false
  let approvalSent = false
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer(async (request, response) => {
    if (closed) return send(response, 503)
    if (request.method !== 'POST' || request.url !== '/v1/responses') return send(response, 404)
    try {
      const encoding = request.headers['content-encoding']
      if (encoding && encoding !== 'gzip') return send(response, 415)
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk)
        length += bytes.length
        if (length > maxBodyBytes) {
          request.destroy()
          return
        }
        chunks.push(bytes)
      }
      const compressed = Buffer.concat(chunks)
      const body =
        encoding === 'gzip' ? gunzipSync(compressed, { maxOutputLength: maxBodyBytes }) : compressed
      const modelRequest = JSON.parse(body.toString('utf8'))
      if (!modelRequest || typeof modelRequest !== 'object' || Array.isArray(modelRequest))
        return send(response, 400)
      if (requests.length >= maxEvents) return send(response, 429)
      requests.push({ modelRequest: sanitize(modelRequest) })
      const trigger = mode === 'approval' && !approvalSent && hasPrompt(modelRequest)
      if (trigger) approvalSent = true
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      const items = trigger
        ? [
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: {
                id: 'fc_fixture',
                type: 'function_call',
                call_id: 'call_fixture',
                name: 'exec_command',
                arguments: '',
              },
            },
            {
              type: 'response.function_call_arguments.delta',
              item_id: 'fc_fixture',
              output_index: 0,
              delta: JSON.stringify(promptArguments),
            },
            {
              type: 'response.function_call_arguments.done',
              item_id: 'fc_fixture',
              output_index: 0,
              arguments: JSON.stringify(promptArguments),
            },
            {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                id: 'fc_fixture',
                type: 'function_call',
                call_id: 'call_fixture',
                name: 'exec_command',
                arguments: JSON.stringify(promptArguments),
              },
            },
          ]
        : [
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [] },
            },
            {
              type: 'response.content_part.added',
              item_id: 'msg_fixture',
              output_index: 0,
              content_index: 0,
              part: { type: 'output_text', text: '' },
            },
            {
              type: 'response.output_text.delta',
              item_id: 'msg_fixture',
              output_index: 0,
              content_index: 0,
              delta: 'native fixture answer',
            },
            {
              type: 'response.output_text.done',
              item_id: 'msg_fixture',
              output_index: 0,
              content_index: 0,
              text: 'native fixture answer',
            },
            {
              type: 'response.content_part.done',
              item_id: 'msg_fixture',
              output_index: 0,
              content_index: 0,
              part: { type: 'output_text', text: 'native fixture answer' },
            },
            {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                id: 'msg_fixture',
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'native fixture answer', annotations: [] }],
              },
            },
          ]
      const responseId = `resp_${requests.length}`
      for (const item of items)
        response.write(
          `event: ${item.type}\ndata: ${JSON.stringify({ ...item, response_id: responseId })}\n\n`,
        )
      response.write(
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: responseId, status: 'completed', output: trigger ? [{ type: 'function_call', call_id: 'call_fixture', name: 'exec_command', arguments: JSON.stringify(promptArguments) }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'native fixture answer', annotations: [] }] }] } })}\n\n`,
      )
      response.end()
    } catch {
      if (!response.headersSent) send(response, 400)
      else response.destroy()
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  const listening = new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  return {
    get port() {
      const address = server.address()
      return address && typeof address !== 'string' ? address.port : 0
    },
    requests,
    async close() {
      if (closed) return
      closed = true
      await listening
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
function send(response: ServerResponse, status: number) {
  response.writeHead(status)
  response.end()
}
function hasPrompt(value: any): boolean {
  return (
    Array.isArray(value.input) &&
    value.input.some((item: any) => JSON.stringify(item).includes('exec_command'))
  )
}
function sanitize(value: any): any {
  if (Array.isArray(value)) return value.map(sanitize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]))
}
