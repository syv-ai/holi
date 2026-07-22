/**
 * The main half of the IPC seam. Pure — no Electron — which is exactly why it
 * is the half worth testing: everything above it is wiring that Task 12 proves
 * by running the app.
 */
import { initTRPC, TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import { callProcedure, toEnvelope } from '../src/main/trpc-call'

const t = initTRPC.create()
const router = t.router({
  ping: t.procedure.query(() => 'pong'),
  vaults: t.router({
    // tRPC drops the input entirely without a validator, so the fixture needs
    // one for the pass-through assertion to mean anything.
    open: t.procedure.input((raw: unknown) => raw).query(({ input }) => ({ opened: input })),
    boom: t.procedure.query(() => {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'no such vault: a/b' })
    }),
    crash: t.procedure.query(() => {
      throw new Error('something genuinely broke')
    }),
  }),
})

describe('callProcedure', () => {
  it('resolves a top-level procedure', async () => {
    expect(await callProcedure(router, { path: 'ping', type: 'query', input: undefined })).toBe(
      'pong',
    )
  })

  it('resolves a nested path and passes the input through', async () => {
    const result = await callProcedure(router, {
      path: 'vaults.open',
      type: 'query',
      input: { remote: 'syv-ai/notes' },
    })
    expect(result).toEqual({ opened: { remote: 'syv-ai/notes' } })
  })

  it('reports an unknown path rather than throwing a TypeError', async () => {
    // tRPC's caller is a proxy, so it produces this itself and its message is
    // better than one invented here — the guard below it exists for the case
    // the proxy ever stops covering.
    await expect(
      callProcedure(router, { path: 'vaults.nope', type: 'query', input: undefined }),
    ).rejects.toThrow(/No procedure found on path/)
  })

  it('does not walk off the end of a path that bottoms out early', async () => {
    await expect(
      callProcedure(router, { path: 'ping.deeper.still', type: 'query', input: undefined }),
    ).rejects.toThrow()
  })

  it('refuses a subscription instead of resolving it once and going silent', async () => {
    await expect(
      callProcedure(router, { path: 'ping', type: 'subscription', input: undefined }),
    ).rejects.toThrow(/do not cross the IPC seam/)
  })
})

describe('toEnvelope', () => {
  it('wraps a value', async () => {
    expect(await toEnvelope(Promise.resolve(42))).toEqual({ ok: true, data: 42 })
  })

  it('keeps the tRPC code, which is the whole reason for the envelope', async () => {
    // An Error crossing Electron's IPC boundary arrives as a mangled string with
    // every property gone, so a NOT_FOUND and a crash become indistinguishable
    // at exactly the point the UI has to tell them apart.
    const envelope = await toEnvelope(
      callProcedure(router, { path: 'vaults.boom', type: 'query', input: undefined }),
    )
    expect(envelope).toEqual({ ok: false, message: 'no such vault: a/b', code: 'NOT_FOUND' })
  })

  it('reports an ordinary crash as INTERNAL_SERVER_ERROR, keeping its message', async () => {
    // tRPC wraps a plain throw, so it arrives with a code too — the distinction
    // the renderer needs is preserved either way.
    const envelope = await toEnvelope(
      callProcedure(router, { path: 'vaults.crash', type: 'query', input: undefined }),
    )
    expect(envelope).toEqual({
      ok: false,
      message: 'something genuinely broke',
      code: 'INTERNAL_SERVER_ERROR',
    })
  })

  it('survives a thrown non-Error', async () => {
    expect(await toEnvelope(Promise.reject('just a string'))).toEqual({
      ok: false,
      message: 'just a string',
    })
  })
})
