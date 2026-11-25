import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { request as httpRequest } from 'node:http'
import { createContextModel } from './codex-context-model.mjs'

test('captures real gzip Responses requests and completes a tool-free synthetic turn', async (t) => {
  const model = await createContextModel()
  t.after(() => model.close())
  const body = { model: 'fixture', input: [{ role: 'user', content: 'synthetic prompt' }] }
  const response = await fetch(`http://127.0.0.1:${model.port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
    body: gzipSync(JSON.stringify(body)),
  })
  assert.equal(response.status, 200)
  const events = (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  const completion = events.find((event) => event.type === 'response.completed')
  assert.equal(completion.response.status, 'completed')
  assert.equal(completion.response.output[0].role, 'assistant')
  assert.equal(
    completion.response.output.some((item) => item.type === 'function_call'),
    false,
  )
  assert.deepEqual(
    model.requests.map((item) => item.body),
    [body],
  )
  assert.deepEqual(model.failures, [])
})

test('concurrent body streams cannot exceed the native request budget', async (t) => {
  const model = await createContextModel()
  t.after(() => model.close())
  const clients = Array.from({ length: 13 }, () => {
    let ready
    const admitted = new Promise((resolve) => {
      ready = resolve
    })
    let finish
    const result = new Promise((resolve) => {
      finish = resolve
    })
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: model.port,
        path: '/v1/responses',
        method: 'POST',
        headers: { expect: '100-continue', 'content-type': 'application/json' },
      },
      (response) => {
        response.resume()
        response.on('end', () => finish(response.statusCode === 200))
      },
    )
    req.once('continue', ready)
    req.once('error', () => {
      ready()
      finish(false)
    })
    req.flushHeaders()
    t.after(() => req.destroy())
    return { req, admitted, result }
  })
  await Promise.all(clients.map((client) => client.admitted))
  for (const client of clients)
    if (!client.req.destroyed) client.req.end(JSON.stringify({ model: 'fixture', input: [] }))
  const outcomes = await Promise.all(clients.map((client) => client.result))
  assert.equal(outcomes.filter(Boolean).length, 12)
  assert.equal(model.requests.length, 12)
})

test('oversized bodies are refused without retaining an unbounded request', async (t) => {
  const model = await createContextModel()
  t.after(() => model.close())
  await assert.rejects(
    fetch(`http://127.0.0.1:${model.port}/v1/responses`, {
      method: 'POST',
      body: 'x'.repeat(1048577),
    }),
  )
  assert.equal(model.requests.length, 0)
  assert.equal(model.failures.length, 1)
})

test('malformed native input is refused without inventing a captured request', async (t) => {
  const model = await createContextModel()
  t.after(() => model.close())
  await assert.rejects(
    fetch(`http://127.0.0.1:${model.port}/v1/responses`, { method: 'POST', body: '{not json' }),
  )
  assert.equal(model.requests.length, 0)
  assert.equal(model.failures.length, 1)
})
