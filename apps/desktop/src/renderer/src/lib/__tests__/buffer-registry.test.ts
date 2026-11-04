/**
 * The registry every open buffer joins.
 *
 * Two channels, deliberately: an **unconditional flush** for the points where
 * losing keystrokes is the worst outcome (quit, blur, tab close), and a
 * **gated save** for ⌘S, which must not write a half-typed `tags: [` into a
 * file the parsers will then refuse.
 */
import { describe, expect, it } from 'vitest'
import {
  flushAllBuffers,
  freezeBuffers,
  registerBuffer,
  saveAllBuffers,
} from '@/lib/buffer-registry'

describe('flushAllBuffers', () => {
  it('waits for every buffer and rejects when any write fails', async () => {
    const calls: string[] = []
    const bad = registerBuffer(async () => {
      calls.push('bad')
      throw new Error('disk is full')
    })
    const good = registerBuffer(async () => void calls.push('good'))
    await expect(flushAllBuffers()).rejects.toThrow('disk is full')
    expect(calls.sort()).toEqual(['bad', 'good'])
    bad()
    good()
  })
})

describe('freezeBuffers', () => {
  it('freezes current and newly registered buffers until nested releases finish', () => {
    const states: boolean[] = []
    const release = registerBuffer(
      async () => {},
      async () => {},
      (frozen) => states.push(frozen),
    )
    const first = freezeBuffers()
    const second = freezeBuffers()
    const lateStates: boolean[] = []
    const late = registerBuffer(
      async () => {},
      async () => {},
      (frozen) => lateStates.push(frozen),
    )

    expect(states).toEqual([true])
    expect(lateStates).toEqual([true])
    first()
    first()
    expect(states).toEqual([true])
    second()
    expect(states).toEqual([true, false])
    expect(lateStates).toEqual([true, false])
    second()
    release()
    late()
  })
})

describe('saveAllBuffers', () => {
  it('saves every open buffer, not just the focused one', async () => {
    const saved: string[] = []
    const a = registerBuffer(
      async () => {},
      async () => void saved.push('a'),
    )
    const b = registerBuffer(
      async () => {},
      async () => void saved.push('b'),
    )
    await saveAllBuffers()
    a()
    b()
    expect(saved.sort()).toEqual(['a', 'b'])
  })

  it('does not let one unwritable buffer take the others down', async () => {
    // ⌘S is followed by a commit. A throw escaping here would skip it, so one
    // read-only file would silently cost the commit for everything else.
    const saved: string[] = []
    const bad = registerBuffer(
      async () => {},
      () => Promise.reject(new Error('disk is full')),
    )
    const good = registerBuffer(
      async () => {},
      async () => void saved.push('good'),
    )
    await expect(saveAllBuffers()).resolves.toBeUndefined()
    bad()
    good()
    expect(saved).toEqual(['good'])
  })

  it('falls back to the unconditional writer when a buffer registers only one', async () => {
    // Every caller that predates the gate keeps working, and a buffer with
    // nothing to gate on does not have to invent a second function.
    const written: string[] = []
    const off = registerBuffer(async () => void written.push('flush'))
    await saveAllBuffers()
    off()
    expect(written).toEqual(['flush'])
  })
})
