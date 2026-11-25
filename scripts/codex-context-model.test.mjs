import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
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

test('malformed native input is refused without inventing a captured request', async (t) => {
  const model = await createContextModel()
  t.after(() => model.close())
  await assert.rejects(
    fetch(`http://127.0.0.1:${model.port}/v1/responses`, { method: 'POST', body: '{not json' }),
  )
  assert.equal(model.requests.length, 0)
  assert.equal(model.failures.length, 1)
})
