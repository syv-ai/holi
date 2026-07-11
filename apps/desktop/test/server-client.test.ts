import { describe, expect, it } from 'vitest'
import { callProcedure, toEnvelope } from '../src/main/server-client'

describe('callProcedure', () => {
  const fakeClient = {
    vaults: {
      list: { query: async (input: unknown) => ['v1', input] },
      create: { mutate: async (input: unknown) => ({ made: input }) },
    },
  }

  it('resolves nested query paths', async () => {
    await expect(callProcedure(fakeClient, { path: 'vaults.list', type: 'query', input: 7 })).resolves.toEqual([
      'v1',
      7,
    ])
  })

  it('resolves mutations', async () => {
    await expect(
      callProcedure(fakeClient, { path: 'vaults.create', type: 'mutation', input: { name: 'x' } }),
    ).resolves.toEqual({ made: { name: 'x' } })
  })

  it('rejects unknown paths and subscription ops', async () => {
    await expect(callProcedure(fakeClient, { path: 'nope.nope', type: 'query', input: null })).rejects.toThrow()
    await expect(
      callProcedure(fakeClient, { path: 'vaults.list', type: 'subscription', input: null }),
    ).rejects.toThrow(/subscription/)
  })
})

describe('toEnvelope', () => {
  it('wraps success and failure', async () => {
    expect(await toEnvelope(Promise.resolve(42))).toEqual({ ok: true, data: 42 })
    const env = await toEnvelope(Promise.reject(Object.assign(new Error('nope'), { data: { code: 'FORBIDDEN' } })))
    expect(env).toEqual({ ok: false, message: 'nope', code: 'FORBIDDEN' })
  })
})
