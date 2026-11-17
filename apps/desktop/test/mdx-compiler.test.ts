import { describe, expect, it, vi } from 'vitest'

const { fromPartition, BrowserWindow } = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  BrowserWindow: vi.fn(),
}))
vi.mock('electron', () => ({
  BrowserWindow,
  session: { fromPartition },
}))

import { createMdxCompiler } from '../src/main/mdx-compiler'

describe('isolated MDX compiler policy', () => {
  it('rejects oversized source before creating a guest session', async () => {
    const compiler = createMdxCompiler('/does-not-need-to-exist')
    await expect(compiler.compile('x'.repeat(256 * 1024 + 1))).rejects.toThrow(/256 KiB/)
    expect(fromPartition).not.toHaveBeenCalled()
    expect(BrowserWindow).not.toHaveBeenCalled()
  })

  it('settles an already-cancelled request without creating a guest', async () => {
    const controller = new AbortController()
    controller.abort()
    const compiler = createMdxCompiler('/does-not-need-to-exist')
    await expect(compiler.compile('# no guest', controller.signal)).rejects.toThrow(/cancelled/)
    expect(fromPartition).not.toHaveBeenCalled()
    expect(BrowserWindow).not.toHaveBeenCalled()
  })
})
