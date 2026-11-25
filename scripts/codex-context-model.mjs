import { createServer } from 'node:http'
import { gunzipSync } from 'node:zlib'

/** Capture native Responses input and return a fixed, tool-free synthetic turn. */
export async function createContextModel() {
  const requests = []
  const failures = []
  const pending = new Set()
  let admissions = 0
  const handle = async (req, res) => {
    if (req.url === '/probe') {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.method !== 'POST' || req.url !== '/v1/responses') throw Error('Unexpected model route')
    if (admissions >= 12) throw Error('Model request bound exceeded')
    admissions++
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 1048576) throw Error('Model request byte bound exceeded')
      chunks.push(chunk)
    }
    let bytes = Buffer.concat(chunks)
    if (req.headers['content-encoding'] === 'gzip')
      bytes = gunzipSync(bytes, { maxOutputLength: 1048576 })
    else if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
      throw Error('Unsupported request encoding')
    const body = JSON.parse(bytes.toString())
    requests.push({ url: req.url, body })
    const message = {
      id: `msg_${requests.length}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Holi context fixture finished.', annotations: [] }],
    }
    const response = {
      id: `resp_${requests.length}`,
      object: 'response',
      created_at: 1,
      model: body.model,
      status: 'completed',
      output: [message],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...message, status: 'in_progress', content: [] },
      },
      {
        type: 'response.content_part.added',
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.delta',
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        delta: 'Holi context fixture finished.',
      },
      {
        type: 'response.output_text.done',
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        text: 'Holi context fixture finished.',
      },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response },
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  }
  const server = createServer((req, res) => {
    const task = handle(req, res).catch((error) => {
      failures.push(String(error))
      res.destroy()
    })
    pending.add(task)
    void task.finally(() => pending.delete(task))
  })
  server.requestTimeout = 15000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    requests,
    failures,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await Promise.all(pending)
    },
  }
}
