import { afterEach, describe, expect, it, vi } from 'vitest'

const { migrateTemplates } = vi.hoisted(() => ({ migrateTemplates: vi.fn() }))
vi.mock('../main/templates', () => ({ migrateTemplates }))
vi.mock('../main/capabilities', () => ({
  PDF_NAMESPACES: ['pdf'],
  pdfCapabilities: vi.fn(() => ({})),
}))
vi.mock('../main/typst-bin', () => ({ sharedTypst: vi.fn(() => async () => {}) }))
vi.mock('../main/signatures', () => ({ createSignatureStore: vi.fn(() => ({})) }))

import { pdfMain } from '../main'

afterEach(() => vi.clearAllMocks())

function context(signal = new AbortController().signal) {
  const order: string[] = []
  const release = vi.fn(() => order.push('release'))
  const ctx = {
    activationSignal: signal,
    root: '/vault',
    userData: '/user-data',
    pauseSyncAndDrain: vi.fn(async () => {
      order.push('hold')
      return release
    }),
    register: vi.fn(() => {
      order.push('register')
      return vi.fn()
    }),
  }
  return { ctx, order, release }
}

describe('PDF activation', () => {
  it('drains sync before migration and registers only after release', async () => {
    const state = context()
    migrateTemplates.mockImplementation(async () => {
      const current = state.order.at(-1)
      if (current !== 'hold') throw new Error('migration preceded the hold')
      state.order.push('migration')
    })
    const dispose = await pdfMain.activate!(state.ctx as never)
    expect(state.order).toEqual(['hold', 'migration', 'release', 'register'])
    expect(state.release).toHaveBeenCalledOnce()
    dispose?.()
  })

  it('releases the hold and never registers after migration failure', async () => {
    migrateTemplates.mockRejectedValue(new Error('disk failed'))
    const state = context()
    await expect(pdfMain.activate!(state.ctx as never)).rejects.toThrow('disk failed')
    expect(state.release).toHaveBeenCalledOnce()
    expect(state.ctx.register).not.toHaveBeenCalled()
  })

  it('releases the hold and never registers when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const state = context(controller.signal)
    await expect(pdfMain.activate!(state.ctx as never)).rejects.toThrow(/cancelled/)
    expect(migrateTemplates).not.toHaveBeenCalled()
    expect(state.release).toHaveBeenCalledOnce()
    expect(state.ctx.register).not.toHaveBeenCalled()
  })
})
