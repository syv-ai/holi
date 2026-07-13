import { describe, expect, it } from 'vitest'
import { encryptionKey, openSealed, seal } from '../src/crypto'

describe('crypto', () => {
  it('round-trips utf8 plaintext', () => {
    const key = encryptionKey()
    const sealed = seal('ghp_secret-token-Ø', key)
    expect(openSealed(sealed, key)).toBe('ghp_secret-token-Ø')
  })

  it('produces a different ciphertext every call (random IV)', () => {
    const key = encryptionKey()
    expect(Buffer.from(seal('x', key)).equals(Buffer.from(seal('x', key)))).toBe(false)
  })

  it('rejects tampered ciphertext', () => {
    const key = encryptionKey()
    const sealed = Buffer.from(seal('x', key))
    sealed[sealed.length - 1] ^= 0xff
    expect(() => openSealed(sealed, key)).toThrow()
  })
})
