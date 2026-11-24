import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { GitHubSession } from '../src/main/github/session'
import { TokenStore, type SafeStorageLike, type StoredAuth } from '../src/main/github/token-store'

const root = process.env.HOLI_550_ROOT!
const key = randomBytes(32)
const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'unknown',
  encryptString(text) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()])
  },
  decryptString(data) {
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
    decipher.setAuthTag(data.subarray(-16))
    return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString()
  },
}
export const store = new TokenStore(join(root, 'userData/github-auth.enc'), safeStorage)
export async function createSession(): Promise<GitHubSession> {
  await mkdir(dirname(join(root, 'userData/github-auth.enc')), { recursive: true })
  const auth: StoredAuth = {
    token: 'fixture-token',
    accountId: 55001,
    login: 'smoke-550',
    name: 'Smoke 550',
    avatarUrl: 'https://avatars.githubusercontent.com/u/55001?v=4',
    scopes: ['repo'],
  }
  await store.write(auth)
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    if (url === 'https://api.github.com/user')
      return Response.json({
        id: 55001,
        login: 'smoke-550',
        name: 'Smoke 550',
        avatar_url: 'https://avatars.githubusercontent.com/u/55001?v=4',
      })
    throw new Error(`Unowned GitHub request denied: ${url}`)
  }
  return GitHubSession.load({ store, fetch })
}
