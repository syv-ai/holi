import { createTRPCClient } from '@trpc/client'
import { describe, expect, it } from 'vitest'
import type { AppRouter } from '@holi/server/router'
import { ipcLink, type TrpcInvoke } from '../src/renderer/src/lib/ipc-link'

function clientWith(invoke: TrpcInvoke) {
  return createTRPCClient<AppRouter>({ links: [ipcLink(invoke)] })
}

describe('ipc tRPC link', () => {
  it('forwards the op and resolves the data', async () => {
    const seen: unknown[] = []
    const client = clientWith(async (op) => {
      seen.push(op)
      return { ok: true, data: { ok: true, service: 'holi-server', time: 't' } }
    })
    const health = await client.health.query()
    expect(health.service).toBe('holi-server')
    expect(seen[0]).toMatchObject({ path: 'health', type: 'query' })
  })

  it('surfaces error envelopes as rejections carrying the message', async () => {
    const client = clientWith(async () => ({ ok: false, message: 'nope', code: 'FORBIDDEN' }))
    await expect(client.health.query()).rejects.toMatchObject({ message: 'nope' })
  })
})
