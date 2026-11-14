import { describe, expect, it } from 'vitest'
import { createFrameOrigins } from '../src/main/frame-origins'

describe('frame-origin leases', () => {
  it('keeps an origin until its last activation owner releases it', () => {
    const { origins, acquire } = createFrameOrigins()
    const releaseA = acquire('http://127.0.0.1:3040')
    const releaseB = acquire('http://127.0.0.1:3040')
    expect(origins.has('http://127.0.0.1:3040')).toBe(true)
    releaseA()
    releaseA()
    expect(origins.has('http://127.0.0.1:3040')).toBe(true)
    const releaseReplacement = acquire('http://127.0.0.1:3040')
    releaseB()
    expect(origins.has('http://127.0.0.1:3040')).toBe(true)
    releaseReplacement()
    expect(origins.has('http://127.0.0.1:3040')).toBe(false)
  })

  it('does not expose mutation through the navigation-policy set', () => {
    const { origins, acquire } = createFrameOrigins()
    acquire('http://127.0.0.1:3040')
    expect('add' in origins).toBe(false)
    expect('delete' in origins).toBe(false)
  })
})
