import assert from 'node:assert/strict'
import test from 'node:test'
import { createCdpClient } from './native-smoke-cdp.mjs'

class FakeSocket extends EventTarget {
  send(raw) {
    this.lastMessage = JSON.parse(raw)
  }
}

test('times out CDP requests that never receive a response', async () => {
  const socket = new FakeSocket()
  const client = createCdpClient(socket, { timeoutMs: 10 })

  await assert.rejects(client.call('Runtime.enable'), /timed out after 10ms/)
  client.close()
})

test('rejects outstanding requests when CDP disconnects', async () => {
  const socket = new FakeSocket()
  const client = createCdpClient(socket)
  const request = client.call('Runtime.enable')
  socket.dispatchEvent(new Event('close'))

  await assert.rejects(request, /CDP socket closed/)
  client.close()
})

test('evaluates through an attached flattened page session', async () => {
  const socket = new FakeSocket()
  const client = createCdpClient(socket)
  const attach = client.attach('page-target')
  socket.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ id: 1, result: { sessionId: 'page-session' } }),
    }),
  )
  const page = await attach
  const evaluation = page.evaluate('document.title')
  assert.deepEqual(socket.lastMessage, {
    id: 2,
    method: 'Runtime.evaluate',
    params: { expression: 'document.title', returnByValue: true, awaitPromise: true },
    sessionId: 'page-session',
  })
  socket.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ id: 2, result: { result: { value: 'Holi' } } }),
    }),
  )
  assert.equal(await evaluation, 'Holi')
  client.close()
})
