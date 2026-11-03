/**
 * The registry every open buffer joins: one flush writes every buffer, for
 * quit, blur and the moments before a commit.
 */
import { describe, expect, it } from 'vitest'
import { flushAllBuffers, registerBuffer } from '@/lib/buffer-registry'

describe('flushAllBuffers', () => {
  it('writes every open buffer, not just the focused one', async () => {
    const written: string[] = []
    const a = registerBuffer(async () => void written.push('a'))
    const b = registerBuffer(async () => void written.push('b'))
    await flushAllBuffers()
    a()
    b()
    expect(written.sort()).toEqual(['a', 'b'])
  })

  it('does not let one unwritable buffer take the others down', async () => {
    // A flush is followed by a commit. A throw escaping here would skip it, so
    // one read-only file would silently cost the commit for everything else.
    const written: string[] = []
    const bad = registerBuffer(() => Promise.reject(new Error('disk is full')))
    const good = registerBuffer(async () => void written.push('good'))
    await expect(flushAllBuffers()).resolves.toBeUndefined()
    bad()
    good()
    expect(written).toEqual(['good'])
  })
})
