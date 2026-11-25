import { afterEach, describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { startCodexTuiModel } from './fixtures/codex-tui-model'

const models: ReturnType<typeof startCodexTuiModel>[] = []
afterEach(async () => {
  await Promise.all(models.splice(0).map((model) => model.close()))
})
function start(mode: 'success' | 'approval' = 'success') {
  const model = startCodexTuiModel({ mode })
  models.push(model)
  return model
}

async function post(port: number, body: Buffer | string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers,
    body: body as BodyInit,
  })
}

describe('loopback Codex Responses model', () => {
  it('streams a completed answer and records request input', async () => {
    const model = start()
    const response = await post(
      model.port,
      JSON.stringify({ input: [{ role: 'user', content: 'hello' }] }),
    )
    const stream = await response.text()
    expect(response.status).toBe(200)
    expect(stream).toContain('native fixture answer')
    expect(stream).toContain('response.completed')
    expect(model.requests[0]?.modelRequest).toEqual({ input: [{ role: 'user', content: 'hello' }] })
  })

  it('accepts gzip requests and emits one approval call before subsequent answers', async () => {
    const model = start('approval')
    const trigger = {
      input: [{ type: 'function_call_output', call_id: 'prior', output: 'previous result' }],
    }
    const first = await post(model.port, gzipSync(Buffer.from(JSON.stringify(trigger))), {
      'content-encoding': 'gzip',
    })
    const firstText = await first.text()
    const next = await post(
      model.port,
      JSON.stringify({ input: [{ type: 'function_call_output', output: 'cancelled' }] }),
    )
    expect(firstText).toContain('"name":"exec_command"')
    expect(firstText).toContain('holi-528-fixture')
    expect(await next.text()).toContain('native fixture answer')
    expect(model.requests).toHaveLength(2)
    expect(JSON.stringify(model.requests)).toContain('previous result')
    expect(JSON.stringify(model.requests)).toContain('cancelled')
  })

  it('rejects invalid routes, methods, encodings, malformed and oversized bodies', async () => {
    const model = start()
    expect((await fetch(`http://127.0.0.1:${model.port}/wrong`, { method: 'POST' })).status).toBe(
      404,
    )
    expect((await fetch(`http://127.0.0.1:${model.port}/v1/responses`)).status).toBe(404)
    expect((await post(model.port, '{}', { 'content-encoding': 'br' })).status).toBe(415)
    expect((await post(model.port, '{')).status).toBe(400)
    expect((await post(model.port, 'x'.repeat(1024 * 1024 + 1))).status).not.toBe(200)
  })

  it('closes idempotently and refuses later connections', async () => {
    const model = start()
    await model.close()
    await model.close()
    await expect(post(model.port, '{}')).rejects.toThrow()
  })
})
