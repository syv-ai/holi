import { describe, expect, it } from 'vitest'
import { googleConnectionId } from '../main/connection-id'

describe('Google connection identity', () => {
  it('distinguishes each vault, issuing client, and Google account without exposing their values', () => {
    const base = googleConnectionId('owner/one', 'client-a', 'subject-1')
    expect(googleConnectionId('owner/two', 'client-a', 'subject-1')).not.toBe(base)
    expect(googleConnectionId('owner/one', 'client-b', 'subject-1')).not.toBe(base)
    expect(googleConnectionId('owner/one', 'client-a', 'subject-2')).not.toBe(base)
    expect(base).not.toContain('owner/one')
  })

  it('refuses incomplete provenance', () => {
    expect(() => googleConnectionId('', 'client-a', 'subject-1')).toThrow()
  })
})
