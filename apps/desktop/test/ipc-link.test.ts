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

  /**
   * The envelope exists to carry the *code* across IPC — `trpc-call.ts` says so
   * in as many words, because an Error crossing Electron's boundary arrives as a
   * bare string and a NOT_FOUND becomes indistinguishable from a crash. This
   * side then dropped it on the floor, so every caller could only match on
   * message text: the settings panel blamed a missing sign-in for what was
   * really a 404 on a vault that is not a GitHub repo at all.
   */
  it('keeps the error code, which is the whole point of the envelope', async () => {
    const client = clientWith(async () => ({ ok: false, message: 'Not Found', code: 'NOT_FOUND' }))
    await expect(client.health.query()).rejects.toMatchObject({
      message: 'Not Found',
      data: { code: 'NOT_FOUND' },
    })
  })

  it('leaves data alone when main sent no code', async () => {
    const client = clientWith(async () => ({ ok: false, message: 'boom' }))
    await expect(client.health.query()).rejects.toMatchObject({ message: 'boom' })
  })
})
