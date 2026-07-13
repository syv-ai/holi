/** AES-256-GCM at-rest encryption for GitHub OAuth tokens and deploy keys.
 * Layout: 12-byte IV ‖ 16-byte auth tag ‖ ciphertext. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from './config'

const ALG = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

export function encryptionKey(): Buffer {
  const key = Buffer.from(config.encryptionKeyHex, 'hex')
  if (key.length !== 32) throw new Error('HOLI_ENCRYPTION_KEY must be 32 bytes of hex')
  return key
}

export function seal(plaintext: string, key: Buffer): Uint8Array {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALG, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct])
}

export function openSealed(sealed: Uint8Array, key: Buffer): string {
  const buf = Buffer.from(sealed)
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ct = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALG, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
